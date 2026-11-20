// SNS da loja (LocalStack): o tópico encomendas-eventos avisa a faturação, que o subscreve com uma fila
// SQS (encomendas-eventos-faturacao, entrega "raw"). A seed publica 30 eventos de faturas emitidas,
// que chegam à fila. Como é uma fila SQS, o migrador move-a para o RabbitMQ como as outras.
//
// Checksum do tópico: sha256 de "<nome do tópico>\n" + as subscrições "<protocolo>\t<nome do destino>\n"
// ordenadas. As mensagens entregues contam como uma fila em esperado.filas (mesmo algoritmo das filas).
import { createHash } from 'node:crypto';
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  PublishBatchCommand,
  SNSClient,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import type { ListSubscriptionsByTopicCommandOutput, ListTopicsCommandOutput } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { DadosLoja } from './dados';

export const TOPICO_EVENTOS = 'encomendas-eventos';
export const FILA_FATURACAO = 'encomendas-eventos-faturacao';
export const QUANTOS_EVENTOS = 30;

export interface ResumoTopico {
  topico: string;
  subscricoes: number;
  checksum: string;
}

/** Os 30 eventos "fatura-emitida" das últimas faturas da série. */
export function gerarEventos(dados: DadosLoja): string[] {
  const porId = new Map(dados.encomendas.map((e) => [e.id, e]));
  return dados.faturas.slice(-QUANTOS_EVENTOS).map((f) => {
    const e = porId.get(f.encomendaId)!;
    return JSON.stringify({ tipo: 'fatura-emitida', fatura: f.numero, encomenda: e.numero, clienteId: e.clienteId, totalCentimos: e.totalCentimos, pdf: `s3://faturas/${f.chave}` });
  });
}

export function checksumTopico(topico: string, subscricoes: { protocolo: string; destino: string }[]): ResumoTopico {
  const h = createHash('sha256').update(`${topico}\n`);
  for (const l of subscricoes.map((s) => `${s.protocolo}\t${s.destino}\n`).sort()) h.update(l);
  return { topico, subscricoes: subscricoes.length, checksum: h.digest('hex') };
}

export interface LigacaoAws {
  endpoint: string;
  regiao: string;
}

const credenciais = { accessKeyId: 'test', secretAccessKey: 'test' }; // convenção do LocalStack, não é segredo

/** Nome do recurso no fim de um ARN ou URL de fila (o que se compara, não a conta nem a região). */
const ultimoNome = (arnOuUrl: string): string => arnOuUrl.split(/[:/]/).pop() ?? arnOuUrl;

/** Recria o tópico, subscreve a fila (raw) e publica os eventos. Espera que cheguem todos à fila. */
export async function escreverSns(aws: LigacaoAws, eventos: string[]): Promise<{ topico: ResumoTopico; entregues: number }> {
  const sns = new SNSClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  const sqs = new SQSClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  try {
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: TOPICO_EVENTOS }));
    if (!TopicArn) throw new Error('SNS não devolveu o ARN do tópico');
    // Recriar do zero: sem subscrições repetidas de corridas anteriores.
    await sns.send(new DeleteTopicCommand({ TopicArn }));
    const criado = await sns.send(new CreateTopicCommand({ Name: TOPICO_EVENTOS }));
    const arn = criado.TopicArn!;

    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: FILA_FATURACAO }));
    if (!QueueUrl) throw new Error(`SQS não devolveu o URL da fila ${FILA_FATURACAO}`);
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
    const atr = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    const filaArn = atr.Attributes?.QueueArn;
    if (!filaArn) throw new Error(`sem ARN da fila ${FILA_FATURACAO}`);
    // Política para o tópico poder escrever na fila (o LocalStack não a exige, a AWS sim).
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: filaArn, Condition: { ArnEquals: { 'aws:SourceArn': arn } } }],
        }),
      },
    }));
    await sns.send(new SubscribeCommand({ TopicArn: arn, Protocol: 'sqs', Endpoint: filaArn, Attributes: { RawMessageDelivery: 'true' } }));

    for (let i = 0; i < eventos.length; i += 10) {
      const r = await sns.send(new PublishBatchCommand({
        TopicArn: arn,
        PublishBatchRequestEntries: eventos.slice(i, i + 10).map((m, j) => ({ Id: String(i + j), Message: m })),
      }));
      if (r.Failed?.length) throw new Error(`SNS recusou ${r.Failed.length} eventos`);
    }

    // A entrega SNS -> SQS é assíncrona: espera até a fila ter todos.
    let entregues = 0;
    for (let tentativa = 0; tentativa < 30 && entregues < eventos.length; tentativa++) {
      const a = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      entregues = Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      if (entregues < eventos.length) await new Promise((r) => setTimeout(r, 300));
    }
    return { topico: await lerTopico(aws), entregues };
  } finally {
    sns.destroy();
    sqs.destroy();
  }
}

/** Lê o tópico e as subscrições do SNS e calcula o checksum. */
export async function lerTopico(aws: LigacaoAws): Promise<ResumoTopico> {
  const sns = new SNSClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  try {
    let arn: string | undefined;
    let token: string | undefined;
    do {
      const r: ListTopicsCommandOutput = await sns.send(new ListTopicsCommand({ NextToken: token }));
      arn ??= r.Topics?.find((t) => t.TopicArn && ultimoNome(t.TopicArn) === TOPICO_EVENTOS)?.TopicArn;
      token = r.NextToken;
    } while (token && !arn);
    if (!arn) throw new Error(`o tópico ${TOPICO_EVENTOS} não existe`);
    const subs: { protocolo: string; destino: string }[] = [];
    token = undefined;
    do {
      const r: ListSubscriptionsByTopicCommandOutput = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: token }));
      for (const s of r.Subscriptions ?? []) subs.push({ protocolo: s.Protocol ?? '', destino: ultimoNome(s.Endpoint ?? '') });
      token = r.NextToken;
    } while (token);
    return checksumTopico(TOPICO_EVENTOS, subs);
  } finally {
    sns.destroy();
  }
}
