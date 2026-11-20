// npm run seed
// Enche a "AWS" simulada (LocalStack: S3, SQS, Secrets Manager e SSM; redis-origem a fazer de
// ElastiCache) e o Postgres (porta 5433) com os dados falsos de
// dados.ts, sempre iguais (semente fixa). No fim imprime contagens e checksums e grava-os em
// seed/esperado.json, para o migrador comparar com o destino.
//
// Aponta sempre para a origem: LOCALSTACK_ENDPOINT (por defeito http://127.0.0.1:4566) e DATABASE_URL.
// Idempotente: recria o esquema "loja", reescreve os objetos e esvazia a fila antes de a encher.
// Não mexe na tabela public.encomendas nem nos objetos faturas/ da app.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import pg from 'pg';
import { carregarEnvLocal, clienteS3, garantirBucket } from '../adaptadores';
import { checksumBucket, checksumMensagens, checksumObjetos, checksumTabela, sha256Hex } from './checksums';
import type { ResumoBucket, ResumoTabela } from './checksums';
import {
  BUCKET_FATURAS,
  BUCKET_FOTOS,
  DATA_REFERENCIA,
  ESQUEMA,
  FILA_ENCOMENDAS,
  FILTRO_FATURAS,
  FILTRO_FOTOS,
  gerarDados,
  QUANTIDADES,
  SEMENTE,
} from './dados';
import type { DadosLoja } from './dados';
import { gerarFaturaPdf, gerarFotoPng } from './ficheiros';
import { checksumCacheGerada, checksumRedis, escreverCache, gerarCache, ligarRedis, PREFIXOS_CACHE } from './cache';
import type { ResumoCache } from './cache';
import { checksumParametros, checksumSegredos, escreverSegredos, gerarSegredos, lerSegredosAws } from './segredos';
import type { ResumoSegredos } from './segredos';

export const CAMINHO_ESPERADO = fileURLToPath(new URL('./esperado.json', import.meta.url));
export const TABELAS = ['clientes', 'produtos', 'encomendas', 'linhas_encomenda'] as const;

export const SQL_ESQUEMA_LOJA = `
DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE;
CREATE SCHEMA ${ESQUEMA};
CREATE TABLE ${ESQUEMA}.clientes (
  id            INTEGER PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('particular', 'empresa')),
  nome          TEXT NOT NULL,
  nif           CHAR(9) NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  morada        TEXT NOT NULL,
  codigo_postal CHAR(8) NOT NULL,
  localidade    TEXT NOT NULL,
  distrito      TEXT NOT NULL,
  criado_em     DATE NOT NULL
);
CREATE TABLE ${ESQUEMA}.produtos (
  id             INTEGER PRIMARY KEY,
  sku            TEXT NOT NULL UNIQUE,
  nome           TEXT NOT NULL,
  categoria      TEXT NOT NULL,
  preco_centimos INTEGER NOT NULL CHECK (preco_centimos > 0),
  taxa_iva       SMALLINT NOT NULL CHECK (taxa_iva IN (6, 13, 23)),
  stock          INTEGER NOT NULL,
  fotos          SMALLINT NOT NULL
);
CREATE TABLE ${ESQUEMA}.encomendas (
  id                INTEGER PRIMARY KEY,
  numero            TEXT NOT NULL UNIQUE,
  cliente_id        INTEGER NOT NULL REFERENCES ${ESQUEMA}.clientes(id),
  criada_em         TIMESTAMPTZ NOT NULL,
  estado            TEXT NOT NULL CHECK (estado IN ('nova', 'paga', 'enviada', 'entregue', 'cancelada')),
  subtotal_centimos INTEGER NOT NULL,
  iva_centimos      INTEGER NOT NULL,
  total_centimos    INTEGER NOT NULL,
  fatura_numero     TEXT UNIQUE
);
CREATE INDEX ON ${ESQUEMA}.encomendas (cliente_id);
CREATE INDEX ON ${ESQUEMA}.encomendas (criada_em);
CREATE TABLE ${ESQUEMA}.linhas_encomenda (
  id                      INTEGER PRIMARY KEY,
  encomenda_id            INTEGER NOT NULL REFERENCES ${ESQUEMA}.encomendas(id),
  produto_id              INTEGER NOT NULL REFERENCES ${ESQUEMA}.produtos(id),
  quantidade              INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario_centimos INTEGER NOT NULL,
  taxa_iva                SMALLINT NOT NULL,
  subtotal_centimos       INTEGER NOT NULL,
  iva_centimos            INTEGER NOT NULL
);
CREATE INDEX ON ${ESQUEMA}.linhas_encomenda (encomenda_id);`;

export interface Esperado {
  semente: number;
  dataReferencia: string;
  esquema: string;
  algoritmos: Record<'bucket' | 'tabela' | 'fila' | 'segredos' | 'cache', string>;
  buckets: Record<string, ResumoBucket & { filtro: string }>;
  tabelas: Record<string, ResumoTabela>;
  filas: Record<string, { mensagens: number; checksum: string }>;
  segredos: { secretsmanager: ResumoSegredos; ssm: ResumoSegredos };
  cache: ResumoCache & { prefixos: string[] };
}

const EM_PARALELO = 8;

export function endpointOrigem(): string {
  return process.env.LOCALSTACK_ENDPOINT?.trim() || 'http://127.0.0.1:4566';
}

async function inserir(cliente: pg.ClientBase, tabela: string, colunas: string[], linhas: unknown[][]): Promise<void> {
  const LOTE = 1000;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const valores = lote.map((_, r) => `(${colunas.map((__, c) => `$${r * colunas.length + c + 1}`).join(', ')})`);
    await cliente.query(`INSERT INTO ${ESQUEMA}.${tabela} (${colunas.join(', ')}) VALUES ${valores.join(', ')}`, lote.flat());
  }
}

async function semearPostgres(dados: DadosLoja): Promise<Record<string, ResumoTabela>> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url || url.includes('<senha>')) throw new Error('DATABASE_URL não está definida no .env (ver env/.env.example)');
  const cliente = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await cliente.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(SQL_ESQUEMA_LOJA);
    await inserir(cliente, 'clientes', ['id', 'tipo', 'nome', 'nif', 'email', 'morada', 'codigo_postal', 'localidade', 'distrito', 'criado_em'],
      dados.clientes.map((c) => [c.id, c.tipo, c.nome, c.nif, c.email, c.morada, c.codigoPostal, c.localidade, c.distrito, c.criadoEm]));
    await inserir(cliente, 'produtos', ['id', 'sku', 'nome', 'categoria', 'preco_centimos', 'taxa_iva', 'stock', 'fotos'],
      dados.produtos.map((p) => [p.id, p.sku, p.nome, p.categoria, p.precoCentimos, p.taxaIva, p.stock, p.fotos]));
    await inserir(cliente, 'encomendas', ['id', 'numero', 'cliente_id', 'criada_em', 'estado', 'subtotal_centimos', 'iva_centimos', 'total_centimos', 'fatura_numero'],
      dados.encomendas.map((e) => [e.id, e.numero, e.clienteId, e.criadaEm, e.estado, e.subtotalCentimos, e.ivaCentimos, e.totalCentimos, e.faturaNumero]));
    await inserir(cliente, 'linhas_encomenda', ['id', 'encomenda_id', 'produto_id', 'quantidade', 'preco_unitario_centimos', 'taxa_iva', 'subtotal_centimos', 'iva_centimos'],
      dados.linhas.map((l) => [l.id, l.encomendaId, l.produtoId, l.quantidade, l.precoUnitarioCentimos, l.taxaIva, l.subtotalCentimos, l.ivaCentimos]));
    await cliente.query('COMMIT');

    const resumo: Record<string, ResumoTabela> = {};
    for (const t of TABELAS) resumo[t] = await checksumTabela(cliente, ESQUEMA, t);
    return resumo;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    await cliente.end();
  }
}

/** Envia os objetos (gerados um a um, para não ter 300 MB em memória) e confirma o ETag (md5). */
async function enviarObjetos(
  s3: S3Client,
  bucket: string,
  itens: { chave: string; tipo: string; gerar: () => Buffer }[],
): Promise<{ chave: string; sha256: string; bytes: number }[]> {
  await garantirBucket(s3, bucket);
  const resultado: { chave: string; sha256: string; bytes: number }[] = [];
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    while (proximo < itens.length) {
      const item = itens[proximo++]!;
      const corpo = item.gerar();
      const r = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: item.chave, Body: corpo, ContentType: item.tipo }));
      const md5 = createHash('md5').update(corpo).digest('hex');
      if (r.ETag && r.ETag.replaceAll('"', '') !== md5) throw new Error(`ETag diferente do enviado: ${bucket}/${item.chave}`);
      resultado.push({ chave: item.chave, sha256: sha256Hex(corpo), bytes: corpo.length });
    }
  };
  await Promise.all(Array.from({ length: EM_PARALELO }, trabalhador));
  return resultado;
}

async function semearS3(dados: DadosLoja): Promise<Record<string, ResumoBucket & { filtro: string }>> {
  const s3 = clienteS3({ endpoint: endpointOrigem(), accessKey: 'test', secretKey: 'test', regiao: process.env.AWS_REGION?.trim() || 'us-east-1' });
  try {
    const encomendas = new Map(dados.encomendas.map((e) => [e.id, e]));
    const clientes = new Map(dados.clientes.map((c) => [c.id, c]));
    const produtos = new Map(dados.produtos.map((p) => [p.id, p]));
    const linhasPor = new Map<number, typeof dados.linhas>();
    for (const l of dados.linhas) linhasPor.set(l.encomendaId, [...(linhasPor.get(l.encomendaId) ?? []), l]);

    const faturas = await enviarObjetos(s3, BUCKET_FATURAS, dados.faturas.map((f) => ({
      chave: f.chave,
      tipo: 'application/pdf',
      gerar: () => {
        const encomenda = encomendas.get(f.encomendaId)!;
        return gerarFaturaPdf({ fatura: f, encomenda, cliente: clientes.get(encomenda.clienteId)!, linhas: linhasPor.get(encomenda.id) ?? [], produtos });
      },
    })));
    console.log(`[seed] ${BUCKET_FATURAS}: ${faturas.length} PDFs enviados`);
    const fotos = await enviarObjetos(s3, BUCKET_FOTOS, dados.fotos.map((f) => ({
      chave: f.chave,
      tipo: 'image/png',
      gerar: () => gerarFotoPng(produtos.get(f.produtoId)!, f.vista),
    })));
    console.log(`[seed] ${BUCKET_FOTOS}: ${fotos.length} PNGs enviados`);

    // Volta a ler tudo do S3 e confirma que o checksum bate com o que se gerou.
    const resumo: Record<string, ResumoBucket & { filtro: string }> = {};
    for (const [bucket, filtro, enviados] of [[BUCKET_FATURAS, FILTRO_FATURAS, faturas], [BUCKET_FOTOS, FILTRO_FOTOS, fotos]] as const) {
      const local = checksumObjetos(enviados);
      const lido = await checksumBucket(s3, bucket, filtro);
      if (lido.checksum !== local.checksum || lido.objetos !== local.objetos) {
        throw new Error(`${bucket}: o que está no S3 (${lido.objetos} objetos) não bate com o gerado (${local.objetos}); há objetos a mais ou alterados`);
      }
      resumo[bucket] = { ...lido, filtro: filtro.source };
    }
    return resumo;
  } finally {
    s3.destroy();
  }
}

async function semearFila(dados: DadosLoja): Promise<Record<string, { mensagens: number; checksum: string }>> {
  const sqs = new SQSClient({
    endpoint: endpointOrigem(),
    region: process.env.AWS_REGION?.trim() || 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 2,
  });
  try {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: FILA_ENCOMENDAS }));
    if (!QueueUrl) throw new Error(`SQS não devolveu o URL da fila ${FILA_ENCOMENDAS}`);
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
    for (let i = 0; i < dados.mensagens.length; i += 10) {
      const lote = dados.mensagens.slice(i, i + 10);
      const r = await sqs.send(new SendMessageBatchCommand({
        QueueUrl,
        Entries: lote.map((corpo, j) => ({ Id: String(i + j), MessageBody: corpo })),
      }));
      if (r.Failed?.length) throw new Error(`SQS recusou ${r.Failed.length} mensagens: ${r.Failed[0]?.Message ?? ''}`);
    }
    // Confirma a contagem (atributo aproximado: espera um pouco se ainda não estiver estável).
    let contagem = -1;
    for (let tentativa = 0; tentativa < 10; tentativa++) {
      const a = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      contagem = Number(a.Attributes?.ApproximateNumberOfMessages ?? -1) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      if (contagem === dados.mensagens.length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (contagem !== dados.mensagens.length) {
      throw new Error(`a fila ${FILA_ENCOMENDAS} tem ${contagem} mensagens, esperava ${dados.mensagens.length}`);
    }
    return { [FILA_ENCOMENDAS]: { mensagens: contagem, checksum: checksumMensagens(dados.mensagens) } };
  } finally {
    sqs.destroy();
  }
}

async function semearSegredos(): Promise<Esperado['segredos']> {
  const aws = { endpoint: endpointOrigem(), regiao: process.env.AWS_REGION?.trim() || 'us-east-1' };
  const gerados = gerarSegredos();
  await escreverSegredos(aws, gerados);
  const lidos = await lerSegredosAws(aws);
  const esperado = { secretsmanager: checksumSegredos(gerados.segredos), ssm: checksumParametros(gerados.parametros) };
  if (lidos.segredos.checksum !== esperado.secretsmanager.checksum) throw new Error(`Secrets Manager: ${lidos.segredos.itens} segredos lidos não batem com os ${esperado.secretsmanager.itens} gerados (há outros com o prefixo?)`);
  if (lidos.parametros.checksum !== esperado.ssm.checksum) throw new Error(`SSM: ${lidos.parametros.itens} parâmetros lidos não batem com os ${esperado.ssm.itens} gerados (há outros com o prefixo?)`);
  return esperado;
}

async function semearCache(dados: DadosLoja): Promise<Esperado['cache']> {
  const url = process.env.REDIS_ORIGEM_URL?.trim();
  if (!url || url.includes('<senha>')) throw new Error('REDIS_ORIGEM_URL não está definida no .env (ver env/.env.example; npm run infra:up)');
  const chaves = gerarCache(dados);
  const cliente = await ligarRedis(url).catch(() => {
    throw new Error('o redis-origem não responde em REDIS_ORIGEM_URL (npm run infra:up)');
  });
  try {
    await escreverCache(cliente, chaves);
    const lido = await checksumRedis(cliente);
    const gerado = checksumCacheGerada(chaves);
    if (lido.checksum !== gerado.checksum) throw new Error(`redis-origem: ${lido.chaves} chaves lidas não batem com as ${gerado.chaves} geradas`);
    return { ...lido, prefixos: [...PREFIXOS_CACHE] };
  } finally {
    await cliente.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  carregarEnvLocal();
  const inicio = Date.now();
  console.log(`[seed] semente ${SEMENTE}, 12 meses até ${DATA_REFERENCIA.slice(0, 10)}; origem ${endpointOrigem()}`);
  const dados = gerarDados();

  const tabelas = await semearPostgres(dados);
  console.log(`[seed] Postgres: esquema ${ESQUEMA} recriado`);
  const filas = await semearFila(dados);
  const segredos = await semearSegredos();
  console.log(`[seed] Secrets Manager: ${segredos.secretsmanager.itens} segredos; SSM: ${segredos.ssm.itens} parâmetros`);
  const cache = await semearCache(dados);
  console.log(`[seed] redis-origem (ElastiCache): ${cache.chaves} chaves, ${cache.comTtl} com TTL`);
  const buckets = await semearS3(dados);

  const esperado: Esperado = {
    semente: SEMENTE,
    dataReferencia: DATA_REFERENCIA,
    esquema: ESQUEMA,
    algoritmos: {
      bucket: 'sha256 das linhas "<chave>\\t<sha256 do objeto>\\n" por ordem de chave, só chaves que passam no filtro',
      tabela: "sha256 de string_agg(t::text, E'\\n' ORDER BY t.id) em UTF-8, com TIME ZONE 'UTC' e DateStyle 'ISO, YMD'",
      fila: 'sha256 dos corpos das mensagens ordenados e unidos por "\\n"',
      segredos: 'sha256 das linhas "<nome>\\t<valor>\\n" (Secrets Manager) ou "<nome>\\t<tipo>\\t<valor>\\n" (SSM), por ordem de nome',
      cache: 'sha256 das linhas "<chave>\\t<tipo>\\t<valor canónico>\\t<ttl|sem-ttl>\\n" por ordem de chave, só os prefixos da seed (seed/cache.ts)',
    },
    buckets,
    tabelas,
    filas,
    segredos,
    cache,
  };
  writeFileSync(CAMINHO_ESPERADO, `${JSON.stringify(esperado, null, 2)}\n`);

  const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const totalBytes = Object.values(buckets).reduce((s, b) => s + b.bytes, 0);
  console.log('\n[seed] contagens e checksums');
  for (const [nome, b] of Object.entries(buckets)) console.log(`  s3   ${nome.padEnd(18)} ${String(b.objetos).padStart(6)} objetos  ${mb(b.bytes).padStart(9)}  ${b.checksum}`);
  for (const [nome, t] of Object.entries(tabelas)) console.log(`  pg   ${`${ESQUEMA}.${nome}`.padEnd(18)} ${String(t.linhas).padStart(6)} linhas              ${t.checksum}`);
  for (const [nome, f] of Object.entries(filas)) console.log(`  sqs  ${nome.padEnd(18)} ${String(f.mensagens).padStart(6)} mensagens           ${f.checksum}`);
  console.log(`  sm   ${'encomendas/prod/*'.padEnd(18)} ${String(segredos.secretsmanager.itens).padStart(6)} segredos            ${segredos.secretsmanager.checksum}`);
  console.log(`  ssm  ${'/encomendas/prod/*'.padEnd(18)} ${String(segredos.ssm.itens).padStart(6)} parâmetros          ${segredos.ssm.checksum}`);
  console.log(`  redis ${'redis-origem'.padEnd(17)} ${String(cache.chaves).padStart(6)} chaves (${cache.comTtl} c/ TTL)  ${cache.checksum}`);
  console.log(`  total nos buckets: ${mb(totalBytes)}; ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
  console.log(`[seed] gravado em ${CAMINHO_ESPERADO}`);

  // Deixa a app coerente: recriar o LocalStack apaga as faturas/<uuid>.txt da app mas não as linhas da
  // public.encomendas. O --repor da exemplo-app apaga as encomendas semeadas e volta a semear 20.
  if (!process.argv.includes('--sem-app')) {
    console.log('[seed] a repor as 20 encomendas da exemplo-app (npm run dev:exemplo -- --repor 20; saltar com --sem-app)');
    const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, '--repor', '20'], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) throw new Error('o --repor da exemplo-app falhou (ver acima)');
  }

  const esperadas = { [BUCKET_FATURAS]: QUANTIDADES.faturas, [BUCKET_FOTOS]: QUANTIDADES.fotos };
  for (const [nome, n] of Object.entries(esperadas)) if (buckets[nome]?.objetos !== n) throw new Error(`${nome}: ${buckets[nome]?.objetos} objetos, esperava ${n}`);
  if (totalBytes < 200 * 1024 * 1024 || totalBytes > 500 * 1024 * 1024) throw new Error(`tamanho total ${mb(totalBytes)} fora de 200-500 MB`);
}

main().catch((erro) => {
  console.error('[seed]', erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
