// DynamoDB da loja (LocalStack): carrinhos guardados e sessões de checkout, derivados dos dados da seed.
// As duas tabelas têm TTL no atributo expiraEm, sempre no futuro (a partir de 2027), para o LocalStack
// não apagar itens a meio de uma demo.
//
// Checksum por tabela: sha256 das linhas "<chave>\t<item em JSON canónico>\n" por ordem de chave, com o
// item no formato AttributeValue do DynamoDB ({"S": ...}, {"N": "..."}, {"L": [...]}, {"M": {...}})
// e as chaves dos objetos ordenadas. É o mesmo formato que a API Alternator do ScyllaDB devolve.
import { createHash } from 'node:crypto';
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ScanCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import { Aleatorio } from './aleatorio';
import { DATA_REFERENCIA, SEMENTE } from './dados';
import type { DadosLoja } from './dados';

type Item = Record<string, AttributeValue>;

export interface TabelaDynamo {
  nome: string;
  chaveParticao: { nome: string; tipo: 'S' | 'N' };
  chaveOrdenacao?: { nome: string; tipo: 'S' | 'N' };
  atributoTtl: string;
  itens: Item[];
}

export interface ResumoDynamo {
  itens: number;
  checksum: string;
}

const S = (s: string): AttributeValue => ({ S: s });
const N = (n: number): AttributeValue => ({ N: String(n) });

export function gerarDynamo(dados: DadosLoja, semente = SEMENTE): TabelaDynamo[] {
  const r = new Aleatorio(semente).filho('dynamo');
  const ref = Date.parse(DATA_REFERENCIA);
  // TTL sempre no futuro: 90 a 180 dias depois da data de referência.
  const expira = (): number => Math.floor(ref / 1000) + r.inteiro(90, 180) * 86_400;

  const carrinhos: Item[] = [];
  let n = 0;
  for (const c of dados.clientes) {
    const quantos = r.chance(0.25) ? 0 : r.inteiro(1, 7);
    for (let i = 0; i < quantos; i++) {
      n++;
      const linhas = r.baralhar(dados.produtos).slice(0, r.inteiro(1, 6)).map((p) => ({ p, q: r.inteiro(1, 4) }));
      const criado = ref - r.inteiro(0, 180) * 86_400_000 - r.inteiro(0, 86_399) * 1000;
      const estado = r.escolher(['aberto', 'abandonado', 'abandonado', 'convertido', 'convertido', 'convertido']);
      carrinhos.push({
        clienteId: N(c.id),
        carrinhoId: S(`CRT-${String(n).padStart(6, '0')}`),
        estado: S(estado),
        criadoEm: S(new Date(criado).toISOString()),
        itens: {
          L: linhas.map(({ p, q }) => ({ M: { sku: S(p.sku), quantidade: N(q), precoCentimos: N(p.precoCentimos) } })),
        },
        totalCentimos: N(linhas.reduce((s, { p, q }) => s + p.precoCentimos * q, 0)),
        ...(r.chance(0.3) ? { cupao: S(r.escolher(['BEMVINDO10', 'NATAL15', 'PORTES0'])) } : {}),
        expiraEm: N(expira()),
      });
    }
  }

  const sessoes: Item[] = [];
  for (let i = 0; i < 300; i++) {
    const c = r.escolher(dados.clientes);
    const id = Array.from({ length: 24 }, () => r.inteiro(0, 15).toString(16)).join('');
    sessoes.push({
      sessaoId: S(`chk_${id}`),
      clienteId: N(c.id),
      passo: S(r.escolher(['morada', 'envio', 'pagamento', 'confirmacao'])),
      metodoPagamento: S(r.escolher(['mbway', 'multibanco', 'cartao', 'transferencia'])),
      moradaEnvio: { M: { morada: S(c.morada), codigoPostal: S(c.codigoPostal), localidade: S(c.localidade) } },
      expiraEm: N(expira()),
    });
  }

  return [
    { nome: 'carrinhos', chaveParticao: { nome: 'clienteId', tipo: 'N' }, chaveOrdenacao: { nome: 'carrinhoId', tipo: 'S' }, atributoTtl: 'expiraEm', itens: carrinhos },
    { nome: 'sessoes-checkout', chaveParticao: { nome: 'sessaoId', tipo: 'S' }, atributoTtl: 'expiraEm', itens: sessoes },
  ];
}

// ---------------------------------------------------------------- checksum

const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON com as chaves dos objetos ordenadas (as listas mantêm a ordem). */
export function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort(porCodigo).map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

function chaveDoItem(t: Pick<TabelaDynamo, 'chaveParticao' | 'chaveOrdenacao'>, item: Item): string {
  const v = (a: AttributeValue | undefined): string => a?.S ?? a?.N ?? '';
  return t.chaveOrdenacao ? `${v(item[t.chaveParticao.nome])}|${v(item[t.chaveOrdenacao.nome])}` : v(item[t.chaveParticao.nome]);
}

export function checksumItens(t: Pick<TabelaDynamo, 'chaveParticao' | 'chaveOrdenacao'>, itens: Item[]): ResumoDynamo {
  const linhas = itens.map((i) => `${chaveDoItem(t, i)}\t${jsonCanonico(i)}\n`).sort(porCodigo);
  const h = createHash('sha256');
  for (const l of linhas) h.update(l);
  return { itens: itens.length, checksum: h.digest('hex') };
}

// ---------------------------------------------------------------- LocalStack

export interface LigacaoAws {
  endpoint: string;
  regiao: string;
}

function cliente(aws: LigacaoAws): DynamoDBClient {
  // "test" é a convenção do LocalStack, não é um segredo.
  return new DynamoDBClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 3 });
}

/** Recria as tabelas e escreve os itens (BatchWriteItem de 25, com repetição dos não processados). */
export async function escreverDynamo(aws: LigacaoAws, tabelas: TabelaDynamo[]): Promise<void> {
  const db = cliente(aws);
  try {
    for (const t of tabelas) {
      await db.send(new DeleteTableCommand({ TableName: t.nome })).catch((erro: Error) => {
        if (erro.name !== 'ResourceNotFoundException') throw erro;
      });
      const chaves = [t.chaveParticao, ...(t.chaveOrdenacao ? [t.chaveOrdenacao] : [])];
      await db.send(new CreateTableCommand({
        TableName: t.nome,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: chaves.map((c) => ({ AttributeName: c.nome, AttributeType: c.tipo })),
        KeySchema: chaves.map((c, i) => ({ AttributeName: c.nome, KeyType: i === 0 ? 'HASH' : 'RANGE' })),
      }));
      await waitUntilTableExists({ client: db, maxWaitTime: 30 }, { TableName: t.nome });
      await db.send(new UpdateTimeToLiveCommand({ TableName: t.nome, TimeToLiveSpecification: { AttributeName: t.atributoTtl, Enabled: true } }));
      for (let i = 0; i < t.itens.length; i += 25) {
        let pedidos = t.itens.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
        for (let tentativa = 0; pedidos.length > 0; tentativa++) {
          if (tentativa > 5) throw new Error(`${t.nome}: ${pedidos.length} itens não foram escritos`);
          const r = await db.send(new BatchWriteItemCommand({ RequestItems: { [t.nome]: pedidos } }));
          pedidos = (r.UnprocessedItems?.[t.nome] ?? []) as typeof pedidos;
        }
      }
    }
  } finally {
    db.destroy();
  }
}

/** Lê uma tabela inteira (Scan paginado) e calcula o checksum. Serve o LocalStack e o Alternator. */
export async function checksumTabelaDynamo(aws: LigacaoAws, t: Pick<TabelaDynamo, 'nome' | 'chaveParticao' | 'chaveOrdenacao'>): Promise<ResumoDynamo> {
  const db = cliente(aws);
  try {
    const itens: Item[] = [];
    let inicio: Item | undefined;
    do {
      const r: ScanCommandOutput = await db.send(new ScanCommand({ TableName: t.nome, ExclusiveStartKey: inicio }));
      itens.push(...((r.Items ?? []) as Item[]));
      inicio = r.LastEvaluatedKey as Item | undefined;
    } while (inicio);
    return checksumItens(t, itens);
  } finally {
    db.destroy();
  }
}
