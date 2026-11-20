// Cache da app de exemplo. A app só conhece a interface Cache; o lado escolhe-se por CACHE_TIPO:
//   CACHE_TIPO=redis (por omissão): REDIS_ORIGEM_URL, o ElastiCache da "AWS"
//   CACHE_TIPO=valkey: VALKEY_URL, o Valkey na Leaseweb
// O Valkey fala o mesmo protocolo do Redis: o cliente é o mesmo e só muda o URL.
import { createClient } from 'redis';

export interface Cache {
  /** Guarda um valor; com `ttlSegundos` expira sozinho. */
  guardar(chave: string, valor: string, ttlSegundos?: number): Promise<void>;
  /** O valor, ou null se não existir (ou já tiver expirado). */
  ler(chave: string): Promise<string | null>;
  apagar(chave: string): Promise<void>;
  /** Com quem está a falar (tipo e host:porta), para logs. Nunca inclui a senha. */
  readonly descricao: string;
  fechar(): Promise<void>;
}

export type TipoCache = 'redis' | 'valkey';

/** host:porta de um URL redis://, sem utilizador nem senha. */
function hostDe(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '6379'}`;
  } catch {
    return '(URL inválido)';
  }
}

/** Lê CACHE_TIPO e o URL desse lado. Valores vazios ou com o marcador <senha> contam como não definidos. */
export function lerCache(env: NodeJS.ProcessEnv = process.env): { tipo: TipoCache; url: string } {
  const v = (nome: string): string | undefined => {
    const valor = env[nome]?.trim();
    return valor && !valor.includes('<senha>') ? valor : undefined;
  };
  const tipo = (v('CACHE_TIPO') ?? 'redis').toLowerCase();
  if (tipo !== 'redis' && tipo !== 'valkey') throw new Error(`CACHE_TIPO desconhecido: ${tipo} (usar redis ou valkey)`);
  const variavel = tipo === 'valkey' ? 'VALKEY_URL' : 'REDIS_ORIGEM_URL';
  const url = v(variavel);
  if (!url) throw new Error(`${variavel} não está definida no .env`);
  return { tipo, url };
}

/** Liga à cache escolhida por CACHE_TIPO. Falha logo, com uma mensagem clara, se não responder. */
export async function criarCache(env: NodeJS.ProcessEnv = process.env): Promise<Cache> {
  const { tipo, url } = lerCache(env);
  const nome = tipo === 'valkey' ? 'Valkey' : 'Redis (ElastiCache)';
  const descricao = `${tipo} ${hostDe(url)}`;
  const cliente = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  cliente.on('error', () => {});
  try {
    await cliente.connect();
    await cliente.ping();
  } catch (erro) {
    try {
      cliente.destroy();
    } catch {
      // nunca chegou a ligar
    }
    const texto = String(erro instanceof Error ? erro.message : erro);
    const porque = /WRONGPASS|NOAUTH|invalid password/i.test(texto) ? 'recusou as credenciais' : 'não responde';
    throw new Error(`${nome} ${porque} em ${hostDe(url)}`);
  }
  return {
    descricao,
    async guardar(chave, valor, ttlSegundos) {
      if (ttlSegundos && ttlSegundos > 0) await cliente.set(chave, valor, { EX: ttlSegundos });
      else await cliente.set(chave, valor);
    },
    async ler(chave) {
      return cliente.get(chave);
    },
    async apagar(chave) {
      await cliente.del(chave);
    },
    async fechar() {
      try {
        cliente.destroy();
      } catch {
        // já estava fechado
      }
    },
  };
}
