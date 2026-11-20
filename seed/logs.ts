// CloudWatch Logs da loja (LocalStack): /encomendas/api (logs de acesso) e /encomendas/worker (JSON do
// serviço que gera as faturas), 3 streams cada, ~10 000 linhas nas 72 h antes da data de referência.
// Sem IPs reais: só os blocos de documentação da RFC 5737 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
//
// Checksum por grupo: sha256 das linhas "<stream>\t<timestamp ms>\t<mensagem>\n" ordenadas.
import { createHash } from 'node:crypto';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DeleteLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  PutLogEventsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { DescribeLogStreamsCommandOutput, GetLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';
import { Aleatorio } from './aleatorio';
import { DATA_REFERENCIA, SEMENTE } from './dados';
import type { DadosLoja } from './dados';

export interface EventoLog {
  stream: string;
  timestamp: number;
  mensagem: string;
}

export interface GrupoLogs {
  nome: string;
  retencaoDias: number;
  eventos: EventoLog[];
}

export interface ResumoLogs {
  streams: number;
  eventos: number;
  checksum: string;
}

const HORA = 3_600_000;

export function gerarLogs(dados: DadosLoja, semente = SEMENTE): GrupoLogs[] {
  const r = new Aleatorio(semente).filho('logs');
  const fim = Date.parse(DATA_REFERENCIA);
  const inicio = fim - 72 * HORA;
  const quando = (): number => inicio + Math.floor(r.proximo() * (fim - inicio));
  const ip = (): string => `${r.escolher(['192.0.2', '198.51.100', '203.0.113'])}.${r.inteiro(1, 254)}`;
  const enc = (): string => r.escolher(dados.encomendas).numero;
  const prod = (): string => r.escolher(dados.produtos).sku;

  const api: EventoLog[] = [];
  const rotas: [() => string, string, number][] = [
    [() => `/api/produtos/${prod()}`, 'GET', 40],
    [() => '/api/produtos?categoria=Mercearia', 'GET', 12],
    [() => `/api/encomendas/${enc()}`, 'GET', 18],
    [() => '/api/encomendas', 'POST', 8],
    [() => '/api/carrinho', 'PUT', 14],
    [() => '/api/checkout/pagamento', 'POST', 5],
    [() => '/saude', 'GET', 3],
  ];
  const totalPeso = rotas.reduce((s, x) => s + x[2], 0);
  for (let i = 0; i < 7000; i++) {
    let x = r.proximo() * totalPeso;
    const rota = rotas.find((c) => (x -= c[2]) < 0) ?? rotas[0]!;
    const estado = r.chance(0.93) ? (rota[1] === 'POST' ? 201 : 200) : r.escolher([304, 400, 404, 404, 429, 500]);
    api.push({
      stream: `api-${r.inteiro(1, 3)}`,
      timestamp: quando(),
      mensagem: `${ip()} - - "${rota[1]} ${rota[0]()} HTTP/1.1" ${estado} ${r.inteiro(120, 24_000)} ${r.inteiro(2, estado >= 500 ? 2900 : 380)}ms`,
    });
  }

  const worker: EventoLog[] = [];
  const faturas = dados.faturas.slice(-600);
  for (let i = 0; i < 3000; i++) {
    const f = r.escolher(faturas);
    const tipo = r.escolher(['fatura-gerada', 'fatura-gerada', 'email-enviado', 'pdf-guardado', 'repetir']);
    worker.push({
      stream: `worker-${r.inteiro(1, 3)}`,
      timestamp: quando(),
      mensagem: JSON.stringify({ nivel: tipo === 'repetir' ? 'aviso' : 'info', evento: tipo, fatura: f.numero, ms: r.inteiro(15, 900) }),
    });
  }

  const ordenar = (e: EventoLog[]): EventoLog[] => e.sort((a, b) => a.timestamp - b.timestamp || (a.mensagem < b.mensagem ? -1 : 1));
  return [
    { nome: '/encomendas/api', retencaoDias: 30, eventos: ordenar(api) },
    { nome: '/encomendas/worker', retencaoDias: 14, eventos: ordenar(worker) },
  ];
}

export function checksumEventos(eventos: EventoLog[]): ResumoLogs {
  const linhas = eventos.map((e) => `${e.stream}\t${e.timestamp}\t${e.mensagem}\n`).sort();
  const h = createHash('sha256');
  for (const l of linhas) h.update(l);
  return { streams: new Set(eventos.map((e) => e.stream)).size, eventos: eventos.length, checksum: h.digest('hex') };
}

export interface LigacaoAws {
  endpoint: string;
  regiao: string;
}

function cliente(aws: LigacaoAws): CloudWatchLogsClient {
  // "test" é a convenção do LocalStack, não é um segredo.
  return new CloudWatchLogsClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 3 });
}

/** Recria os grupos e envia os eventos por stream, por ordem cronológica, em lotes de 1000. */
export async function escreverLogs(aws: LigacaoAws, grupos: GrupoLogs[]): Promise<void> {
  const cw = cliente(aws);
  try {
    for (const g of grupos) {
      await cw.send(new DeleteLogGroupCommand({ logGroupName: g.nome })).catch((erro: Error) => {
        if (erro.name !== 'ResourceNotFoundException') throw erro;
      });
      await cw.send(new CreateLogGroupCommand({ logGroupName: g.nome }));
      await cw.send(new PutRetentionPolicyCommand({ logGroupName: g.nome, retentionInDays: g.retencaoDias }));
      const porStream = new Map<string, EventoLog[]>();
      for (const e of g.eventos) porStream.set(e.stream, [...(porStream.get(e.stream) ?? []), e]);
      for (const [stream, eventos] of [...porStream].sort(([a], [b]) => (a < b ? -1 : 1))) {
        await cw.send(new CreateLogStreamCommand({ logGroupName: g.nome, logStreamName: stream }));
        for (let i = 0; i < eventos.length; i += 1000) {
          await cw.send(new PutLogEventsCommand({
            logGroupName: g.nome,
            logStreamName: stream,
            logEvents: eventos.slice(i, i + 1000).map((e) => ({ timestamp: e.timestamp, message: e.mensagem })),
          }));
        }
      }
    }
  } finally {
    cw.destroy();
  }
}

/** Lê todos os eventos de um grupo (todas as streams, do início) e calcula o checksum. */
export async function lerGrupoLogs(aws: LigacaoAws, grupo: string): Promise<ResumoLogs> {
  const cw = cliente(aws);
  try {
    const streams: string[] = [];
    let token: string | undefined;
    do {
      const r: DescribeLogStreamsCommandOutput = await cw.send(new DescribeLogStreamsCommand({ logGroupName: grupo, nextToken: token }));
      for (const s of r.logStreams ?? []) if (s.logStreamName) streams.push(s.logStreamName);
      token = r.nextToken;
    } while (token);
    const eventos: EventoLog[] = [];
    for (const stream of streams) {
      let anterior: string | undefined;
      let proximo: string | undefined;
      for (;;) {
        const r: GetLogEventsCommandOutput = await cw.send(new GetLogEventsCommand({ logGroupName: grupo, logStreamName: stream, startFromHead: true, nextToken: proximo }));
        for (const e of r.events ?? []) eventos.push({ stream, timestamp: e.timestamp ?? 0, mensagem: e.message ?? '' });
        anterior = proximo;
        proximo = r.nextForwardToken;
        // Fim da stream: o token repete-se (ou não há eventos novos).
        if (!proximo || proximo === anterior || (r.events ?? []).length === 0) break;
      }
    }
    return checksumEventos(eventos);
  } finally {
    cw.destroy();
  }
}
