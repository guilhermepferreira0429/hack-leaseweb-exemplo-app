// npm run seed:limpar-destino -- --sim
// Esvazia no DESTINO só o que a seed pôs lá através do migrador, para a demo começar com o destino vazio:
//   MinIO: os buckets da seed (faturas e fotos-produtos)
//   Valkey: FLUSHDB na base do VALKEY_URL (o Valkey de destino é só da demo)
//   RabbitMQ: apaga as filas encomendas-novas (seed) e encomendas-criadas (app); o verificar() usa a
//             existência delas para saber se a fila já foi migrada
//   OpenBao: os caminhos aws/secretsmanager/encomendas/prod/ e aws/ssm/encomendas/prod/
//   Postgres de destino: DROP SCHEMA loja e DROP TABLE public.encomendas (só no destino)
// Nunca toca na origem (LocalStack, redis-origem, Postgres de origem): recusa se um destino apontar para ela.
// Sem --sim só mostra o que apagaria.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as amqp from 'amqplib';
import pg from 'pg';
import { carregarEnvLocal, clienteS3 } from '../adaptadores';
import { lerLado } from './comparar';
import { ligarRedis } from './cache';
import { apagarSegredosOpenBao } from './segredos';

const CAMINHO_ESPERADO = fileURLToPath(new URL('./esperado.json', import.meta.url));

function hostPorta(url: string): string {
  const u = new URL(url);
  const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
  return `${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

async function main(): Promise<void> {
  carregarEnvLocal();
  const apagar = process.argv.includes('--sim');
  const destino = lerLado(true);
  const origem = lerLado(false);
  // Salvaguarda: se o .env apontar o MinIO para o LocalStack, isto apagaria a origem.
  if (hostPorta(destino.s3.endpoint) === hostPorta(origem.s3.endpoint)) {
    throw new Error(`MINIO_ENDPOINT (${destino.s3.endpoint}) é o mesmo que a origem: recuso apagar`);
  }
  const esperado = JSON.parse(readFileSync(CAMINHO_ESPERADO, 'utf8')) as { esquema: string; buckets: Record<string, unknown>; filas: Record<string, unknown> };
  const buckets = Object.keys(esperado.buckets);
  const s3 = clienteS3(destino.s3);
  try {
    for (const bucket of buckets) {
      let total = 0;
      try {
        if (apagar) {
          // Apaga em lotes de 1000 e volta a listar do início até o bucket ficar vazio.
          for (;;) {
            const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
            const chaves = (r.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
            if (chaves.length === 0) break;
            const d = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chaves, Quiet: true } }));
            if (d.Errors?.length) throw new Error(`${bucket}: ${d.Errors.length} objetos não foram apagados (${d.Errors[0]?.Message ?? ''})`);
            total += chaves.length;
          }
        } else {
          let token: string | undefined;
          do {
            const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
            total += r.Contents?.length ?? 0;
            token = r.IsTruncated ? r.NextContinuationToken : undefined;
          } while (token);
        }
      } catch (erro) {
        if ((erro as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
          console.log(`  ${bucket}: não existe no destino (nada a fazer)`);
          continue;
        }
        throw erro;
      }
      console.log(`  ${bucket}: ${total} objetos ${apagar ? 'apagados' : 'seriam apagados'}`);
    }
  } finally {
    s3.destroy();
  }

  // Valkey: salvaguarda igual à do MinIO (nunca o mesmo servidor que o redis-origem).
  if (destino.redisUrl) {
    if (origem.redisUrl && hostPorta(destino.redisUrl) === hostPorta(origem.redisUrl)) {
      throw new Error('VALKEY_URL aponta para o mesmo servidor que REDIS_ORIGEM_URL: recuso apagar');
    }
    const valkey = await ligarRedis(destino.redisUrl).catch(() => {
      throw new Error('o Valkey não responde em VALKEY_URL');
    });
    try {
      // FLUSHDB só na base do URL (db 0 por omissão): o Valkey de destino é só da demo, e chaves a mais
      // (de outras corridas) fazem a prova do migrador dar diferente.
      const n = await valkey.dbSize();
      if (apagar) await valkey.flushDb();
      console.log(`  valkey: ${n} chaves (FLUSHDB) ${apagar ? 'apagadas' : 'seriam apagadas'}`);
    } finally {
      await valkey.close().catch(() => {});
    }
  } else {
    console.log('  valkey: sem VALKEY_URL no .env (saltado)');
  }

  if (destino.openbao) {
    const n = await apagarSegredosOpenBao(destino.openbao, apagar);
    console.log(`  openbao: ${n} segredos e parâmetros da seed ${apagar ? 'apagados' : 'seriam apagados'}`);
  } else {
    console.log('  openbao: sem OPENBAO_TOKEN no .env (saltado)');
  }

  // RabbitMQ: apaga as filas da demo. Uma 2.ª corrida do migrarFila somaria mensagens, e o verificar()
  // acha que a fila já foi migrada enquanto a encomendas-criadas existir.
  if (destino.rabbitmqUrl) {
    const ligacao = await amqp.connect(destino.rabbitmqUrl).catch(() => {
      throw new Error('o RabbitMQ não responde em RABBITMQ_URL');
    });
    ligacao.on('error', () => {});
    try {
      // encomendas-eventos-faturacao: a fila do SNS (seed:extra), que o migrarFila também move.
      for (const fila of [...Object.keys(esperado.filas), 'encomendas-criadas', 'encomendas-eventos-faturacao']) {
        const canal = await ligacao.createChannel();
        canal.on('error', () => {});
        try {
          const { messageCount } = await canal.checkQueue(fila);
          if (apagar) await canal.deleteQueue(fila);
          console.log(`  rabbitmq ${fila}: fila com ${messageCount} mensagens ${apagar ? 'apagada' : 'seria apagada'}`);
          await canal.close().catch(() => {});
        } catch {
          console.log(`  rabbitmq ${fila}: a fila não existe (nada a fazer)`);
        }
      }
    } finally {
      await ligacao.close().catch(() => {});
    }
  } else {
    console.log('  rabbitmq: sem RABBITMQ_URL no .env (saltado)');
  }

  // Postgres de destino: só o esquema da seed. Recusa se for a mesma base que a origem.
  if (destino.databaseUrl && !destino.databaseUrl.includes('<senha>')) {
    const origemUrl = process.env.DATABASE_URL?.trim();
    const alvo = (u: string): string => {
      const x = new URL(u);
      return `${x.hostname === 'localhost' ? '127.0.0.1' : x.hostname}:${x.port || '5432'}${x.pathname}`;
    };
    if (origemUrl && alvo(origemUrl) === alvo(destino.databaseUrl)) {
      throw new Error('DATABASE_URL_DESTINO aponta para a mesma base que DATABASE_URL: recuso apagar');
    }
    const bd = new pg.Client({ connectionString: destino.databaseUrl, connectionTimeoutMillis: 5000 });
    await bd.connect().catch(() => {
      throw new Error('o Postgres de destino não responde em DATABASE_URL_DESTINO');
    });
    try {
      const r = await bd.query<{ n: number }>('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1', [esperado.esquema]);
      const n = r.rows[0]?.n ?? 0;
      const app = (await bd.query<{ t: string | null }>("SELECT to_regclass('public.encomendas')::text AS t")).rows[0]?.t;
      if (apagar) {
        await bd.query(`DROP SCHEMA IF EXISTS "${esperado.esquema}" CASCADE`);
        await bd.query('DROP TABLE IF EXISTS public.encomendas');
      }
      console.log(`  postgres-destino: esquema ${esperado.esquema} (${n} tabelas)${app ? ' e public.encomendas' : ''} ${apagar ? 'apagados' : 'seriam apagados'}`);
    } finally {
      await bd.end().catch(() => {});
    }
  } else {
    console.log('  postgres-destino: sem DATABASE_URL_DESTINO no .env (saltado)');
  }

  console.log(apagar ? `[seed:limpar-destino] destino limpo (só o que é da demo)` : '[seed:limpar-destino] nada apagado; para apagar: npm run seed:limpar-destino -- --sim');
}

main().catch((erro) => {
  console.error('[seed:limpar-destino]', erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
