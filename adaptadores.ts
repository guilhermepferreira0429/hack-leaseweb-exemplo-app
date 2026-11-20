// Adaptadores da app de exemplo. A app só conhece estas interfaces; o ambiente
// (AWS via LocalStack, ou Leaseweb com MinIO) escolhe-se por variáveis de ambiente.
//   ARMAZENAMENTO_ENDPOINT, ARMAZENAMENTO_BUCKET, ARMAZENAMENTO_ACCESS_KEY, ARMAZENAMENTO_SECRET_KEY
//   DATABASE_URL
//   FILA_TIPO=sqs (por omissão): FILA_URL, FILA_NOME no LocalStack
//   FILA_TIPO=rabbitmq: RABBITMQ_URL e FILA_NOME (Leaseweb)
// Sem ARMAZENAMENTO_* a app usa o LocalStack (a "AWS" da demo), com as credenciais de teste dele.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import * as amqp from 'amqplib';
import pg from 'pg';

export interface Armazenamento {
  guardar(chave: string, conteudo: Buffer, tipo?: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  listar(prefixo?: string): Promise<string[]>;
  apagar(chave: string): Promise<void>;
  /** Onde está a falar (endpoint e bucket), para logs. Nunca inclui chaves. */
  readonly descricao: string;
  fechar(): Promise<void>;
}

export interface BaseDados {
  consultar<T = unknown>(sql: string, parametros?: unknown[]): Promise<T[]>;
  fechar(): Promise<void>;
}

export interface Fila {
  enviar(mensagem: string): Promise<void>;
  /** Recebe e confirma até `maximo` mensagens. */
  receber(maximo?: number): Promise<string[]>;
  fechar(): Promise<void>;
}

const CAMINHO_ENV = fileURLToPath(new URL('../../.env', import.meta.url));
const LOCALSTACK_POR_DEFEITO = 'http://127.0.0.1:4566';

/** Carrega o .env da raiz, se existir. As variáveis já definidas no processo ganham. */
export function carregarEnvLocal(): void {
  if (existsSync(CAMINHO_ENV)) process.loadEnvFile(CAMINHO_ENV);
}

export interface Ambiente {
  armazenamento: { endpoint: string; bucket: string; accessKey: string; secretKey: string; regiao: string };
  databaseUrl: string;
  fila: {
    /** sqs (LocalStack, a "AWS") ou rabbitmq (Leaseweb). */
    tipo: 'sqs' | 'rabbitmq';
    endpoint: string;
    nome: string;
    accessKey: string;
    secretKey: string;
    regiao: string;
    /** Só para rabbitmq. */
    rabbitmqUrl?: string;
  };
}

/** Lê o ambiente. Valores vazios contam como não definidos. */
export function lerAmbiente(env: NodeJS.ProcessEnv = process.env): Ambiente {
  const v = (nome: string): string | undefined => env[nome]?.trim() || undefined;
  const localstack = v('LOCALSTACK_ENDPOINT') ?? LOCALSTACK_POR_DEFEITO;
  const regiao = v('AWS_REGION') ?? 'us-east-1';
  const databaseUrl = v('DATABASE_URL');
  if (!databaseUrl || databaseUrl.includes('<senha>')) {
    throw new Error('DATABASE_URL não está definida no .env (ver env/.env.example)');
  }
  const tipoFila = (v('FILA_TIPO') ?? 'sqs').toLowerCase();
  if (tipoFila !== 'sqs' && tipoFila !== 'rabbitmq') throw new Error(`FILA_TIPO desconhecido: ${tipoFila} (sqs ou rabbitmq)`);
  const rabbitmqUrl = v('RABBITMQ_URL');
  if (tipoFila === 'rabbitmq' && (!rabbitmqUrl || rabbitmqUrl.includes('<senha>'))) {
    throw new Error('FILA_TIPO=rabbitmq mas RABBITMQ_URL não está definida no .env');
  }
  return {
    armazenamento: {
      endpoint: v('ARMAZENAMENTO_ENDPOINT') ?? localstack,
      bucket: v('ARMAZENAMENTO_BUCKET') ?? 'faturas',
      // O LocalStack aceita quaisquer credenciais; "test" é a convenção dele, não é um segredo.
      accessKey: v('ARMAZENAMENTO_ACCESS_KEY') ?? 'test',
      secretKey: v('ARMAZENAMENTO_SECRET_KEY') ?? 'test',
      regiao,
    },
    databaseUrl,
    fila: {
      tipo: tipoFila,
      rabbitmqUrl,
      endpoint: v('FILA_URL') ?? localstack,
      nome: v('FILA_NOME') ?? 'encomendas-criadas',
      accessKey: v('FILA_ACCESS_KEY') ?? 'test',
      secretKey: v('FILA_SECRET_KEY') ?? 'test',
      regiao,
    },
  };
}

/** Cliente S3 que serve o LocalStack e o MinIO (path style, checksums só quando obrigatórios). */
export function clienteS3(c: { endpoint: string; accessKey: string; secretKey: string; regiao: string }): S3Client {
  return new S3Client({
    endpoint: c.endpoint,
    region: c.regiao,
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
}

/** Cria o bucket se ainda não existir. */
export async function garantirBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (erro) {
    const estado = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (estado !== 404) throw erro;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

/** S3 e MinIO falam a mesma API: um só adaptador com @aws-sdk/client-s3 (forcePathStyle para MinIO). */
export function criarArmazenamento(env?: NodeJS.ProcessEnv): Armazenamento {
  const c = lerAmbiente(env).armazenamento;
  const s3 = clienteS3(c);
  let bucketPronto: Promise<void> | undefined;
  const pronto = (): Promise<void> => (bucketPronto ??= garantirBucket(s3, c.bucket).catch((erro) => {
    bucketPronto = undefined;
    throw erro;
  }));

  return {
    descricao: `${c.endpoint}/${c.bucket}`,
    async guardar(chave, conteudo, tipo) {
      await pronto();
      await s3.send(new PutObjectCommand({ Bucket: c.bucket, Key: chave, Body: conteudo, ContentType: tipo }));
    },
    async ler(chave) {
      const r = await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: chave }));
      if (!r.Body) throw new Error(`Objeto sem corpo: ${chave}`);
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async listar(prefixo) {
      const chaves: string[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(
          new ListObjectsV2Command({ Bucket: c.bucket, Prefix: prefixo, ContinuationToken: token }),
        );
        for (const o of r.Contents ?? []) if (o.Key) chaves.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return chaves;
    },
    async apagar(chave) {
      await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: chave }));
    },
    async fechar() {
      s3.destroy();
    },
  };
}

export function criarBaseDados(env?: NodeJS.ProcessEnv): BaseDados {
  const pool = new pg.Pool({ connectionString: lerAmbiente(env).databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  // Sem isto, uma ligação que cai em repouso derruba o processo.
  pool.on('error', () => {});
  return {
    async consultar<T = unknown>(sql: string, parametros?: unknown[]) {
      const r = await pool.query(sql, parametros as unknown[] | undefined);
      return r.rows as T[];
    },
    async fechar() {
      await pool.end();
    },
  };
}

/** SQS (@aws-sdk/client-sqs) ou RabbitMQ (amqplib), conforme FILA_TIPO. O resto da app não muda. */
export function criarFila(env?: NodeJS.ProcessEnv): Fila {
  const c = lerAmbiente(env).fila;
  return c.tipo === 'rabbitmq' ? criarFilaRabbitMq(c.rabbitmqUrl!, c.nome) : criarFilaSqs(c);
}

/** RabbitMQ: fila durável, mensagens persistentes, publisher confirms e ack manual. */
function criarFilaRabbitMq(url: string, nome: string): Fila {
  let ligacao: Promise<{ modelo: amqp.ChannelModel; canal: amqp.ConfirmChannel }> | undefined;
  const ligar = (): Promise<{ modelo: amqp.ChannelModel; canal: amqp.ConfirmChannel }> =>
    (ligacao ??= (async () => {
      const modelo = await amqp.connect(url);
      modelo.on('error', () => {});
      const canal = await modelo.createConfirmChannel();
      canal.on('error', () => {});
      await canal.assertQueue(nome, { durable: true });
      return { modelo, canal };
    })().catch((erro) => {
      ligacao = undefined;
      throw erro;
    }));

  return {
    async enviar(mensagem) {
      const { canal } = await ligar();
      canal.sendToQueue(nome, Buffer.from(mensagem), { persistent: true, contentType: 'application/json' });
      await canal.waitForConfirms();
    },
    async receber(maximo = 10) {
      const { canal } = await ligar();
      const corpos: string[] = [];
      // Como o SQS com WaitTimeSeconds=1: espera até 1 s pela primeira mensagem.
      const limite = Date.now() + 1000;
      while (corpos.length < Math.max(maximo, 1)) {
        const m = await canal.get(nome, { noAck: false });
        if (m) {
          corpos.push(m.content.toString());
          canal.ack(m);
        } else if (corpos.length === 0 && Date.now() < limite) {
          await new Promise((r) => setTimeout(r, 100));
        } else {
          break;
        }
      }
      return corpos;
    },
    async fechar() {
      if (!ligacao) return;
      const atual = ligacao;
      ligacao = undefined;
      const { modelo } = await atual.catch(() => ({ modelo: undefined }));
      await modelo?.close().catch(() => {});
    },
  };
}

function criarFilaSqs(c: Ambiente['fila']): Fila {
  const sqs = new SQSClient({
    endpoint: c.endpoint,
    region: c.regiao,
    credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secretKey },
    maxAttempts: 2,
  });
  let url: Promise<string> | undefined;
  const urlFila = (): Promise<string> => (url ??= sqs
    .send(new CreateQueueCommand({ QueueName: c.nome })) // idempotente: devolve a fila se já existir
    .then((r) => {
      if (!r.QueueUrl) throw new Error(`SQS não devolveu o URL da fila ${c.nome}`);
      return r.QueueUrl;
    })
    .catch((erro) => {
      url = undefined;
      throw erro;
    }));

  return {
    async enviar(mensagem) {
      await sqs.send(new SendMessageCommand({ QueueUrl: await urlFila(), MessageBody: mensagem }));
    },
    async receber(maximo = 10) {
      const QueueUrl = await urlFila();
      const r = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: Math.min(Math.max(maximo, 1), 10), WaitTimeSeconds: 1 }),
      );
      const mensagens = r.Messages ?? [];
      if (mensagens.length > 0) {
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl,
            Entries: mensagens.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
          }),
        );
      }
      return mensagens.map((m) => m.Body ?? '');
    },
    async fechar() {
      sqs.destroy();
    },
  };
}
