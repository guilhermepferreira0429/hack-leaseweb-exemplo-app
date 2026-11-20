// Cache da loja no "ElastiCache" (redis-origem): sessões, carrinhos, cache de produtos, stock reservado,
// rankings, emails pendentes. Derivado dos dados da seed, por isso também determinístico.
// As chaves com TTL têm 6 a 48 h, para não expirarem a meio de uma demo.
//
// Checksum: sha256 das linhas "chave\ttipo\tvalor-canónico\tttl|sem-ttl\n", por ordem de chave.
//   string -> o valor; hash -> "campo=valor" ordenados por campo, unidos por \n; list -> JSON pela ordem;
//   set -> membros ordenados, JSON; zset -> "membro:score" ordenados por membro, JSON.
// O TTL entra só como "tem ou não tem", porque o valor exato desce com o tempo.
import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { Aleatorio } from './aleatorio';
import { SEMENTE } from './dados';
import type { DadosLoja } from './dados';

export type ClienteRedis = ReturnType<typeof createClient>;
export type TipoChave = 'string' | 'hash' | 'list' | 'set' | 'zset';
export type ValorChave = string | Record<string, string> | string[] | { membro: string; score: number }[];

export interface ChaveCache {
  chave: string;
  tipo: TipoChave;
  valor: ValorChave;
  /** Segundos; sem TTL se undefined. */
  ttl?: number;
}

/** Todos os prefixos que a seed usa. O checksum e o limpar-destino só olham para estes. */
export const PREFIXOS_CACHE = ['sessao:', 'carrinho:', 'cache:produto:', 'stock:reservado:', 'ranking:', 'emails:', 'clientes:'] as const;

const HORA = 3600;

export function gerarCache(dados: DadosLoja, semente = SEMENTE): ChaveCache[] {
  const r = new Aleatorio(semente).filho('cache');
  const chaves: ChaveCache[] = [];
  const clientes = dados.clientes;
  const recentes = dados.encomendas.slice(-600);

  for (const p of dados.produtos) {
    chaves.push({
      chave: `cache:produto:${p.sku}`,
      tipo: 'string',
      valor: JSON.stringify({ sku: p.sku, nome: p.nome, precoCentimos: p.precoCentimos, taxaIva: p.taxaIva, stock: p.stock }),
      ttl: r.inteiro(6, 24) * HORA,
    });
    chaves.push({ chave: `stock:reservado:${p.sku}`, tipo: 'string', valor: String(r.inteiro(0, Math.min(25, p.stock))) });
  }

  for (let i = 0; i < 200; i++) {
    const cliente = r.escolher(clientes);
    const id = Array.from({ length: 32 }, () => r.inteiro(0, 15).toString(16)).join('');
    const enc = r.escolher(recentes);
    chaves.push({
      chave: `sessao:${id}`,
      tipo: 'hash',
      valor: { clienteId: String(cliente.id), criadaEm: enc.criadaEm, idioma: r.chance(0.92) ? 'pt-PT' : 'en', carrinho: `carrinho:${cliente.id}` },
      ttl: r.inteiro(6, 48) * HORA,
    });
  }

  const comCarrinho = r.baralhar(clientes).slice(0, 150);
  for (const c of comCarrinho) {
    const itens: Record<string, string> = {};
    for (const p of r.baralhar(dados.produtos).slice(0, r.inteiro(1, 6))) itens[p.sku] = String(r.inteiro(1, 4));
    chaves.push({ chave: `carrinho:${c.id}`, tipo: 'hash', valor: itens, ttl: r.inteiro(24, 48) * HORA });
  }

  const vendidos = new Map<number, number>();
  for (const l of dados.linhas) vendidos.set(l.produtoId, (vendidos.get(l.produtoId) ?? 0) + l.quantidade);
  chaves.push({
    chave: 'ranking:mais-vendidos',
    tipo: 'zset',
    valor: dados.produtos.map((p) => ({ membro: p.sku, score: vendidos.get(p.id) ?? 0 })),
  });

  const fim = Date.parse(dados.encomendas[dados.encomendas.length - 1]!.criadaEm);
  const gastos = new Map<number, number>();
  for (const e of dados.encomendas) {
    if (fim - Date.parse(e.criadaEm) <= 30 * 86_400_000 && e.estado !== 'cancelada') {
      gastos.set(e.clienteId, (gastos.get(e.clienteId) ?? 0) + e.totalCentimos);
    }
  }
  chaves.push({
    chave: 'ranking:clientes-30-dias',
    tipo: 'zset',
    valor: [...gastos].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 50).map(([id, total]) => ({ membro: `cliente:${id}`, score: total })),
  });

  const porId = new Map(dados.encomendas.map((e) => [e.id, e]));
  chaves.push({
    chave: 'emails:pendentes',
    tipo: 'list',
    valor: dados.faturas.slice(-30).map((f) => {
      const e = porId.get(f.encomendaId)!;
      const c = clientes[e.clienteId - 1]!;
      return JSON.stringify({ para: c.email, assunto: `Fatura ${f.numero}`, anexo: f.chave });
    }),
  });

  chaves.push({
    chave: 'clientes:ativos-hoje',
    tipo: 'set',
    valor: [...new Set(r.baralhar(clientes).slice(0, 40).map((c) => String(c.id)))],
  });

  return chaves;
}

// ---------------------------------------------------------------- checksum

const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function valorCanonico(tipo: TipoChave, valor: ValorChave): string {
  switch (tipo) {
    case 'string':
      return valor as string;
    case 'hash': {
      const h = valor as Record<string, string>;
      return Object.keys(h).sort(porCodigo).map((k) => `${k}=${h[k]}`).join('\n');
    }
    case 'list':
      return JSON.stringify(valor);
    case 'set':
      return JSON.stringify([...(valor as string[])].sort(porCodigo));
    case 'zset':
      return JSON.stringify(
        [...(valor as { membro: string; score: number }[])].sort((a, b) => porCodigo(a.membro, b.membro)).map((m) => `${m.membro}:${m.score}`),
      );
  }
}

export interface ResumoCache {
  chaves: number;
  comTtl: number;
  checksum: string;
}

export function checksumChaves(chaves: { chave: string; tipo: TipoChave; valor: ValorChave; temTtl: boolean }[]): ResumoCache {
  const h = createHash('sha256');
  for (const c of [...chaves].sort((a, b) => porCodigo(a.chave, b.chave))) {
    h.update(`${c.chave}\t${c.tipo}\t${valorCanonico(c.tipo, c.valor)}\t${c.temTtl ? 'ttl' : 'sem-ttl'}\n`);
  }
  return { chaves: chaves.length, comTtl: chaves.filter((c) => c.temTtl).length, checksum: h.digest('hex') };
}

/** Todas as chaves com os prefixos dados (SCAN, nunca KEYS). */
export async function listarChaves(cliente: ClienteRedis, prefixos: readonly string[] = PREFIXOS_CACHE): Promise<string[]> {
  const vistas = new Set<string>();
  for (const prefixo of prefixos) {
    for await (const lote of cliente.scanIterator({ MATCH: `${prefixo}*`, COUNT: 1000 })) {
      for (const k of Array.isArray(lote) ? lote : [lote]) vistas.add(String(k));
    }
  }
  return [...vistas];
}

/** Lê as chaves da seed de um Redis/Valkey e calcula o checksum (o mesmo nos dois lados). */
export async function checksumRedis(cliente: ClienteRedis, prefixos: readonly string[] = PREFIXOS_CACHE): Promise<ResumoCache> {
  const lidas: { chave: string; tipo: TipoChave; valor: ValorChave; temTtl: boolean }[] = [];
  for (const chave of await listarChaves(cliente, prefixos)) {
    const tipo = (await cliente.type(chave)) as string;
    let valor: ValorChave;
    if (tipo === 'string') valor = (await cliente.get(chave)) ?? '';
    else if (tipo === 'hash') valor = await cliente.hGetAll(chave);
    else if (tipo === 'list') valor = await cliente.lRange(chave, 0, -1);
    else if (tipo === 'set') valor = await cliente.sMembers(chave);
    else if (tipo === 'zset') valor = (await cliente.zRangeWithScores(chave, 0, -1)).map((m) => ({ membro: String(m.value), score: m.score }));
    else if (tipo === 'none') continue; // expirou entre o SCAN e a leitura
    else throw new Error(`tipo de chave não suportado: ${chave} (${tipo})`);
    const ttl = await cliente.pTTL(chave);
    lidas.push({ chave, tipo: tipo as TipoChave, valor, temTtl: ttl > 0 });
  }
  return checksumChaves(lidas);
}

export function checksumCacheGerada(chaves: ChaveCache[]): ResumoCache {
  return checksumChaves(chaves.map((c) => ({ chave: c.chave, tipo: c.tipo, valor: c.valor, temTtl: c.ttl !== undefined })));
}

// ---------------------------------------------------------------- escrita

export async function ligarRedis(url: string): Promise<ClienteRedis> {
  const cliente = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  // Sem ouvinte, um erro de ligação mata o processo. Nunca se mostra o URL (tem a senha).
  cliente.on('error', () => {});
  await cliente.connect();
  return cliente;
}

/** Apaga as chaves com os prefixos da seed. Devolve quantas apagou. */
export async function apagarChavesSeed(cliente: ClienteRedis, prefixos: readonly string[] = PREFIXOS_CACHE): Promise<number> {
  const chaves = await listarChaves(cliente, prefixos);
  for (let i = 0; i < chaves.length; i += 500) await cliente.del(chaves.slice(i, i + 500));
  return chaves.length;
}

/** Recria as chaves da seed (apaga as antigas com os mesmos prefixos primeiro). */
export async function escreverCache(cliente: ClienteRedis, chaves: ChaveCache[]): Promise<void> {
  await apagarChavesSeed(cliente);
  for (let i = 0; i < chaves.length; i += 200) {
    const m = cliente.multi();
    for (const c of chaves.slice(i, i + 200)) {
      if (c.tipo === 'string') m.set(c.chave, c.valor as string);
      else if (c.tipo === 'hash') m.hSet(c.chave, c.valor as Record<string, string>);
      else if (c.tipo === 'list') m.rPush(c.chave, c.valor as string[]);
      else if (c.tipo === 'set') m.sAdd(c.chave, c.valor as string[]);
      else m.zAdd(c.chave, (c.valor as { membro: string; score: number }[]).map((x) => ({ value: x.membro, score: x.score })));
      if (c.ttl !== undefined) m.expire(c.chave, c.ttl);
    }
    await m.exec();
  }
}
