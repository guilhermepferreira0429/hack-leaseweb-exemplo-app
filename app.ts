// App de encomendas, mínima e realista:
// registarEncomenda guarda a fatura no armazenamento (S3), a linha na base de dados (RDS Postgres)
// e publica um evento na fila (SQS) para outro serviço processar.
import { createHash, randomUUID } from 'node:crypto';
import { criarArmazenamento, criarBaseDados, criarFila } from './adaptadores';
import type { Armazenamento, BaseDados, Fila } from './adaptadores';

export interface Encomenda {
  id: string;
  cliente: string;
  totalCentimos: number;
  /** Chave da fatura no armazenamento. */
  faturaChave: string;
  /** sha256 da fatura no momento em que foi guardada: prova que o ficheiro não mudou na migração. */
  faturaSha256: string;
  criadaEm: string;
}

export interface Dependencias {
  armazenamento: Armazenamento;
  baseDados: BaseDados;
  fila: Fila;
}

/** Prefixo das faturas no armazenamento. */
export const PREFIXO_FATURAS = 'faturas/';

export const SQL_ESQUEMA = `
CREATE TABLE IF NOT EXISTS encomendas (
  id            TEXT PRIMARY KEY,
  cliente       TEXT NOT NULL,
  total_centimos INTEGER NOT NULL,
  fatura_chave  TEXT NOT NULL,
  fatura_sha256 TEXT,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE encomendas ADD COLUMN IF NOT EXISTS fatura_sha256 TEXT;`;

type Linha = {
  id: string;
  cliente: string;
  total_centimos: number;
  fatura_chave: string;
  fatura_sha256: string | null;
  criada_em: Date;
};

const COLUNAS = 'id, cliente, total_centimos, fatura_chave, fatura_sha256, criada_em';

function paraEncomenda(l: Linha): Encomenda {
  return {
    id: l.id,
    cliente: l.cliente,
    totalCentimos: l.total_centimos,
    faturaChave: l.fatura_chave,
    faturaSha256: l.fatura_sha256 ?? '',
    criadaEm: new Date(l.criada_em).toISOString(),
  };
}

export function sha256Hex(conteudo: Uint8Array): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

/** Os três adaptadores a partir das variáveis de ambiente. */
export function criarDependencias(env?: NodeJS.ProcessEnv): Dependencias {
  return { armazenamento: criarArmazenamento(env), baseDados: criarBaseDados(env), fila: criarFila(env) };
}

export async function fecharDependencias(deps: Dependencias): Promise<void> {
  await Promise.allSettled([deps.armazenamento.fechar(), deps.baseDados.fechar(), deps.fila.fechar()]);
}

export async function prepararEsquema(deps: Dependencias): Promise<void> {
  await deps.baseDados.consultar(SQL_ESQUEMA);
}

export async function registarEncomenda(
  deps: Dependencias,
  dados: { cliente: string; totalCentimos: number; fatura: Buffer },
): Promise<Encomenda> {
  const id = randomUUID();
  const faturaChave = `${PREFIXO_FATURAS}${id}.txt`;
  const faturaSha256 = sha256Hex(dados.fatura);
  // Primeiro o ficheiro: nunca fica uma linha na base de dados a apontar para uma fatura que não existe.
  await deps.armazenamento.guardar(faturaChave, dados.fatura, 'text/plain; charset=utf-8');
  const [linha] = await deps.baseDados.consultar<Linha>(
    `INSERT INTO encomendas (id, cliente, total_centimos, fatura_chave, fatura_sha256)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUNAS}`,
    [id, dados.cliente, dados.totalCentimos, faturaChave, faturaSha256],
  );
  if (!linha) throw new Error(`A base de dados não devolveu a encomenda ${id}`);
  await deps.fila.enviar(JSON.stringify({ tipo: 'encomenda-criada', id }));
  return paraEncomenda(linha);
}

export async function obterEncomenda(deps: Dependencias, id: string): Promise<Encomenda | undefined> {
  const [linha] = await deps.baseDados.consultar<Linha>(`SELECT ${COLUNAS} FROM encomendas WHERE id = $1`, [id]);
  return linha ? paraEncomenda(linha) : undefined;
}

/** Todas as encomendas, por ordem de criação. */
export async function listarEncomendas(deps: Dependencias): Promise<Encomenda[]> {
  const linhas = await deps.baseDados.consultar<Linha>(`SELECT ${COLUNAS} FROM encomendas ORDER BY criada_em, id`);
  return linhas.map(paraEncomenda);
}

/** Apaga a encomenda e a fatura (usado pelos testes para não deixar lixo). */
export async function apagarEncomenda(deps: Dependencias, encomenda: Encomenda): Promise<void> {
  await deps.baseDados.consultar('DELETE FROM encomendas WHERE id = $1', [encomenda.id]);
  await deps.armazenamento.apagar(encomenda.faturaChave);
}

/** Consome eventos 'encomenda-criada' da fila e devolve os ids das encomendas. */
export async function processarEventos(deps: Dependencias, maximo = 10): Promise<string[]> {
  const ids: string[] = [];
  for (const corpo of await deps.fila.receber(maximo)) {
    try {
      const evento = JSON.parse(corpo) as { tipo?: unknown; id?: unknown };
      if (evento.tipo === 'encomenda-criada' && typeof evento.id === 'string') ids.push(evento.id);
    } catch {
      // Mensagem que não é nossa: ignora-se (já foi confirmada pela fila).
    }
  }
  return ids;
}

const CLIENTES = ['Padaria Ribeiro', 'Oficina Sousa', 'Farmácia Lopes', 'Livraria Nunes', 'Café Central', 'Talho Moura'];

/** Cria dados de exemplo (N encomendas com faturas) para a migração ter o que copiar. */
export async function semear(deps: Dependencias, quantidade: number): Promise<Encomenda[]> {
  const criadas: Encomenda[] = [];
  for (let i = 0; i < quantidade; i++) {
    const cliente = CLIENTES[i % CLIENTES.length]!;
    const totalCentimos = 500 + ((i * 7919) % 50000);
    const linhas = Array.from({ length: 1 + (i % 4) }, (_, j) => `  artigo ${j + 1} .......... ${((totalCentimos / (j + 2)) / 100).toFixed(2)} EUR`);
    const fatura = Buffer.from(
      [`FATURA`, `Cliente: ${cliente}`, ...linhas, `Total: ${(totalCentimos / 100).toFixed(2)} EUR`, ''].join('\n'),
      'utf8',
    );
    criadas.push(await registarEncomenda(deps, { cliente, totalCentimos, fatura }));
  }
  return criadas;
}
