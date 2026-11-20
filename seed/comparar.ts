// npm run seed:comparar              -> confere a origem (LocalStack, DATABASE_URL, REDIS_ORIGEM_URL) com esperado.json
// npm run seed:comparar -- --destino -> confere o destino (MinIO, DATABASE_URL_DESTINO, RabbitMQ, OpenBao, Valkey)
// Prova independente do migrador: recalcula os checksums do zero e compara-os com os que a seed gravou.
// Só lê. Sai com código 1 se alguma coisa não bater.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import * as amqp from 'amqplib';
import pg from 'pg';
import { carregarEnvLocal, clienteS3 } from '../adaptadores';
import { checksumBucket, checksumTabela } from './checksums';
import type { ResumoBucket, ResumoTabela } from './checksums';
import { checksumRedis, ligarRedis } from './cache';
import type { ResumoCache } from './cache';
import { lerSegredosAws, lerSegredosOpenBao } from './segredos';
import type { LigacaoOpenBao, ResumoSegredos } from './segredos';
import { checksumTabelaDynamo } from './dynamo';
import type { ResumoDynamo } from './dynamo';
import { lerTopico } from './sns';
import type { ResumoTopico } from './sns';
import { lerGrupoLogs } from './logs';
import type { ResumoLogs } from './logs';

const CAMINHO_ESPERADO = fileURLToPath(new URL('./esperado.json', import.meta.url));
const CAMINHO_EXTRA = fileURLToPath(new URL('./esperado-extra.json', import.meta.url));

interface EsperadoExtra {
  dynamodb: Record<string, ResumoDynamo & { chaveParticao: { nome: string; tipo: 'S' | 'N' }; chaveOrdenacao?: { nome: string; tipo: 'S' | 'N' } }>;
  sns: ResumoTopico;
  filas: Record<string, { mensagens: number; checksum: string }>;
  logs: Record<string, ResumoLogs>;
}

interface Esperado {
  esquema: string;
  buckets: Record<string, ResumoBucket & { filtro: string }>;
  tabelas: Record<string, ResumoTabela>;
  filas: Record<string, { mensagens: number; checksum: string }>;
  segredos?: { secretsmanager: ResumoSegredos; ssm: ResumoSegredos };
  cache?: ResumoCache & { prefixos: string[] };
}

export interface LinhaComparacao {
  tipo: 's3' | 'pg' | 'sqs' | 'amqp' | 'sm' | 'ssm' | 'bao' | 'redis' | 'ddb' | 'sns' | 'logs';
  nome: string;
  esperado: string;
  encontrado: string;
  ok: boolean | null; // null: não comparado (e porquê, em `encontrado`)
}

export interface Lado {
  nome: string;
  s3: { endpoint: string; accessKey: string; secretKey: string; regiao: string };
  databaseUrl?: string;
  /** A origem tem SQS; o destino tem RabbitMQ. Das filas só se compara a contagem (ler os corpos consumia-as). */
  sqsEndpoint?: string;
  rabbitmqUrl?: string;
  /** Origem: Secrets Manager + SSM no LocalStack. Destino: OpenBao. */
  segredosAws?: { endpoint: string; regiao: string };
  openbao?: LigacaoOpenBao;
  /** redis-origem (ElastiCache) ou Valkey. */
  redisUrl?: string;
  redisNome: string;
}

const v = (nome: string): string | undefined => process.env[nome]?.trim() || undefined;
/** Variáveis com o marcador do .env.example contam como não definidas. */
const vReal = (nome: string): string | undefined => {
  const x = v(nome);
  return x && !x.includes('<senha>') ? x : undefined;
};

export function lerLado(destino: boolean): Lado {
  const regiao = v('AWS_REGION') ?? 'us-east-1';
  const localstack = v('LOCALSTACK_ENDPOINT') ?? 'http://127.0.0.1:4566';
  if (!destino) {
    return {
      nome: `origem (LocalStack ${localstack})`,
      // O LocalStack aceita quaisquer credenciais; "test" é a convenção dele, não é um segredo.
      s3: { endpoint: localstack, accessKey: 'test', secretKey: 'test', regiao },
      databaseUrl: v('DATABASE_URL'),
      sqsEndpoint: localstack,
      segredosAws: { endpoint: localstack, regiao },
      redisUrl: vReal('REDIS_ORIGEM_URL'),
      redisNome: 'redis-origem',
    };
  }
  const accessKey = v('MINIO_ACCESS_KEY');
  const secretKey = v('MINIO_SECRET_KEY');
  if (!accessKey || !secretKey) throw new Error('MINIO_ACCESS_KEY e MINIO_SECRET_KEY não estão definidas no .env');
  const endpoint = v('MINIO_ENDPOINT') ?? 'http://127.0.0.1:9000';
  const rabbitmqUrl = v('RABBITMQ_URL');
  return {
    nome: `destino (MinIO ${endpoint})`,
    s3: { endpoint, accessKey, secretKey, regiao },
    databaseUrl: v('DATABASE_URL_DESTINO'),
    rabbitmqUrl: rabbitmqUrl && !rabbitmqUrl.includes('<senha>') ? rabbitmqUrl : undefined,
    openbao: vReal('OPENBAO_TOKEN') ? { endereco: v('OPENBAO_ADDR') ?? 'http://127.0.0.1:8200', token: vReal('OPENBAO_TOKEN')! } : undefined,
    redisUrl: vReal('VALKEY_URL'),
    redisNome: 'valkey',
  };
}

const curto = (h: string): string => (/^[0-9a-f]{64}$/.test(h) ? `${h.slice(0, 12)}…` : h);

export async function comparar(lado: Lado, esperado: Esperado = JSON.parse(readFileSync(CAMINHO_ESPERADO, 'utf8'))): Promise<LinhaComparacao[]> {
  const linhas: LinhaComparacao[] = [];

  const s3 = clienteS3(lado.s3);
  try {
    for (const [bucket, e] of Object.entries(esperado.buckets)) {
      const fmt = (r: ResumoBucket): string => `${r.objetos} obj ${curto(r.checksum)}`;
      try {
        const r = await checksumBucket(s3, bucket, new RegExp(e.filtro));
        linhas.push({ tipo: 's3', nome: bucket, esperado: fmt(e), encontrado: fmt(r), ok: r.objetos === e.objetos && r.checksum === e.checksum });
      } catch (erro) {
        const estado = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        linhas.push({ tipo: 's3', nome: bucket, esperado: fmt(e), encontrado: estado === 404 ? 'bucket não existe' : String((erro as Error).message), ok: false });
      }
    }
  } finally {
    s3.destroy();
  }

  for (const [tabela, e] of Object.entries(esperado.tabelas)) {
    const nome = `${esperado.esquema}.${tabela}`;
    const fmt = (r: ResumoTabela): string => `${r.linhas} linhas ${curto(r.checksum)}`;
    if (!lado.databaseUrl || lado.databaseUrl.includes('<senha>')) {
      linhas.push({ tipo: 'pg', nome, esperado: fmt(e), encontrado: 'sem URL da base de dados no .env', ok: null });
      continue;
    }
    const cliente = new pg.Client({ connectionString: lado.databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      await cliente.connect();
      const r = await checksumTabela(cliente, esperado.esquema, tabela);
      linhas.push({ tipo: 'pg', nome, esperado: fmt(e), encontrado: fmt(r), ok: r.linhas === e.linhas && r.checksum === e.checksum });
    } catch (erro) {
      linhas.push({ tipo: 'pg', nome, esperado: fmt(e), encontrado: (erro as Error).message, ok: false });
    } finally {
      await cliente.end().catch(() => {});
    }
  }

  for (const [fila, e] of Object.entries(esperado.filas)) {
    if (!lado.sqsEndpoint) {
      if (!lado.rabbitmqUrl) {
        linhas.push({ tipo: 'amqp', nome: fila, esperado: `${e.mensagens} msg`, encontrado: 'sem RABBITMQ_URL no .env', ok: null });
        continue;
      }
      try {
        const ligacao = await amqp.connect(lado.rabbitmqUrl);
        // Sem estes ouvintes, um canal fechado pelo servidor (ex.: 404 fila inexistente) mata o processo.
        ligacao.on('error', () => {});
        try {
          const canal = await ligacao.createChannel();
          canal.on('error', () => {});
          const { messageCount } = await canal.checkQueue(fila);
          linhas.push({ tipo: 'amqp', nome: fila, esperado: `${e.mensagens} msg`, encontrado: `${messageCount} msg`, ok: messageCount === e.mensagens });
        } finally {
          await ligacao.close().catch(() => {});
        }
      } catch (erro) {
        const texto = (erro as Error).message ?? String(erro);
        linhas.push({ tipo: 'amqp', nome: fila, esperado: `${e.mensagens} msg`, encontrado: /404|NOT_FOUND/.test(texto) ? 'fila ainda não existe (por migrar)' : texto, ok: false });
      }
      continue;
    }
    // Só conta: ler os corpos para o checksum obrigaria a receber as mensagens (e a mexer na fila).
    const sqs = new SQSClient({ endpoint: lado.sqsEndpoint, region: lado.s3.regiao, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 2 });
    try {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: fila }));
      const a = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      const n = Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      // O migrador MOVE as mensagens para o RabbitMQ: fila vazia na origem não é erro (confere-se no destino).
      if (n === 0) linhas.push({ tipo: 'sqs', nome: fila, esperado: `${e.mensagens} msg`, encontrado: '0 msg (já migrada? ver --destino)', ok: null });
      else linhas.push({ tipo: 'sqs', nome: fila, esperado: `${e.mensagens} msg`, encontrado: `${n} msg`, ok: n === e.mensagens });
    } catch (erro) {
      linhas.push({ tipo: 'sqs', nome: fila, esperado: `${e.mensagens} msg`, encontrado: (erro as Error).message || (erro as Error).name, ok: false });
    } finally {
      sqs.destroy();
    }
  }
  if (esperado.segredos) {
    const e = esperado.segredos;
    const fmt = (r: ResumoSegredos, o: string): string => `${r.itens} ${o} ${curto(r.checksum)}`;
    try {
      if (lado.segredosAws) {
        const r = await lerSegredosAws(lado.segredosAws);
        linhas.push({ tipo: 'sm', nome: 'encomendas/prod/*', esperado: fmt(e.secretsmanager, 'segredos'), encontrado: fmt(r.segredos, 'segredos'), ok: r.segredos.checksum === e.secretsmanager.checksum });
        linhas.push({ tipo: 'ssm', nome: '/encomendas/prod/*', esperado: fmt(e.ssm, 'parâm.'), encontrado: fmt(r.parametros, 'parâm.'), ok: r.parametros.checksum === e.ssm.checksum });
      } else if (lado.openbao) {
        const r = await lerSegredosOpenBao(lado.openbao);
        linhas.push({ tipo: 'bao', nome: 'aws/secretsmanager/*', esperado: fmt(e.secretsmanager, 'segredos'), encontrado: fmt(r.segredos, 'segredos'), ok: r.segredos.checksum === e.secretsmanager.checksum });
        linhas.push({ tipo: 'bao', nome: 'aws/ssm/*', esperado: fmt(e.ssm, 'parâm.'), encontrado: fmt(r.parametros, 'parâm.'), ok: r.parametros.checksum === e.ssm.checksum });
      } else {
        linhas.push({ tipo: 'bao', nome: 'segredos', esperado: fmt(e.secretsmanager, 'segredos'), encontrado: 'sem OPENBAO_TOKEN no .env', ok: null });
      }
    } catch (erro) {
      linhas.push({ tipo: lado.openbao ? 'bao' : 'sm', nome: 'segredos', esperado: fmt(e.secretsmanager, 'segredos'), encontrado: (erro as Error).message, ok: false });
    }
  }

  if (esperado.cache) {
    const e = esperado.cache;
    const fmt = (r: ResumoCache): string => `${r.chaves} chaves (${r.comTtl} TTL) ${curto(r.checksum)}`;
    if (!lado.redisUrl) {
      linhas.push({ tipo: 'redis', nome: lado.redisNome, esperado: fmt(e), encontrado: `sem ${lado.redisNome === 'valkey' ? 'VALKEY_URL' : 'REDIS_ORIGEM_URL'} no .env`, ok: null });
    } else {
      try {
        const cliente = await ligarRedis(lado.redisUrl);
        try {
          const r = await checksumRedis(cliente, e.prefixos);
          linhas.push({ tipo: 'redis', nome: lado.redisNome, esperado: fmt(e), encontrado: fmt(r), ok: r.checksum === e.checksum });
        } finally {
          await cliente.close().catch(() => {});
        }
      } catch (erro) {
        // Nunca se mostra o URL (tem a senha).
        linhas.push({ tipo: 'redis', nome: lado.redisNome, esperado: fmt(e), encontrado: `não responde (${(erro as Error).name})`, ok: false });
      }
    }
  }
  // Fase seguinte (npm run seed:extra): DynamoDB, SNS e CloudWatch Logs, só na origem.
  if (existsSync(CAMINHO_EXTRA)) {
    const x = JSON.parse(readFileSync(CAMINHO_EXTRA, 'utf8')) as EsperadoExtra;
    if (!lado.segredosAws) {
      linhas.push({ tipo: 'ddb', nome: 'DynamoDB, SNS, Logs', esperado: 'fase seguinte', encontrado: 'sem destino hoje (só no plano)', ok: null });
    } else {
      const aws = lado.segredosAws;
      const tenta = async (tipo: LinhaComparacao['tipo'], nome: string, esperado: string, fn: () => Promise<{ texto: string; ok: boolean }>): Promise<void> => {
        try {
          const r = await fn();
          linhas.push({ tipo, nome, esperado, encontrado: r.texto, ok: r.ok });
        } catch (erro) {
          // Fase seguinte: se não foi semeado nesta máquina, não é erro (não aparece a vermelho na demo).
          const naoExiste = (erro as Error).name === 'ResourceNotFoundException' || /não existe/.test((erro as Error).message);
          linhas.push({ tipo, nome, esperado, encontrado: naoExiste ? 'não semeado (npm run seed:extra)' : (erro as Error).message, ok: naoExiste ? null : false });
        }
      };
      for (const [nome, e] of Object.entries(x.dynamodb)) {
        await tenta('ddb', nome, `${e.itens} itens ${curto(e.checksum)}`, async () => {
          const r = await checksumTabelaDynamo(aws, { nome, chaveParticao: e.chaveParticao, chaveOrdenacao: e.chaveOrdenacao });
          return { texto: `${r.itens} itens ${curto(r.checksum)}`, ok: r.checksum === e.checksum };
        });
      }
      await tenta('sns', x.sns.topico, `${x.sns.subscricoes} subscr. ${curto(x.sns.checksum)}`, async () => {
        const r = await lerTopico(aws);
        return { texto: `${r.subscricoes} subscr. ${curto(r.checksum)}`, ok: r.checksum === x.sns.checksum };
      });
      for (const [nome, e] of Object.entries(x.logs)) {
        await tenta('logs', nome, `${e.eventos} eventos ${curto(e.checksum)}`, async () => {
          const r = await lerGrupoLogs(aws, nome);
          return { texto: `${r.eventos} eventos ${curto(r.checksum)}`, ok: r.checksum === e.checksum };
        });
      }
    }
  }
  return linhas;
}

async function main(): Promise<void> {
  carregarEnvLocal();
  const lado = lerLado(process.argv.includes('--destino'));
  console.log(`[seed:comparar] ${lado.nome} contra seed/esperado.json`);
  const linhas = await comparar(lado);
  for (const l of linhas) {
    const marca = l.ok === null ? '--' : l.ok ? 'OK' : 'XX';
    console.log(`  ${marca}  ${l.tipo.padEnd(5)}  ${l.nome.padEnd(22)}  esperado ${l.esperado.padEnd(28)}  encontrado ${l.encontrado}`);
  }
  const falhas = linhas.filter((l) => l.ok === false).length;
  const comparados = linhas.filter((l) => l.ok !== null).length;
  console.log(`[seed:comparar] ${comparados - falhas}/${comparados} iguais${falhas ? `; ${falhas} DIFERENTES` : ''}`);
  if (falhas) process.exitCode = 1;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('seed/comparar.ts')) {
  main().catch((erro) => {
    console.error('[seed:comparar]', erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  });
}
