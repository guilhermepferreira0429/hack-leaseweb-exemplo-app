// npm run dev:exemplo [-- --semear 20 | --repor 20]
// Corre a app contra o ambiente definido nas variáveis (LocalStack ou Leaseweb).
// --repor N: só na origem ("AWS"). Apaga as encomendas semeadas (linha e fatura) e semeia N de novo,
// para a base de dados e o S3 ficarem coerentes (ex.: depois de o LocalStack ser recriado).
import { carregarEnvLocal } from './adaptadores';
import {
  apagarEncomenda,
  criarDependencias,
  fecharDependencias,
  listarEncomendas,
  prepararEsquema,
  processarEventos,
  PREFIXO_FATURAS,
  semear,
} from './app';

function argNumero(nome: string): number | undefined {
  const i = process.argv.indexOf(nome);
  if (i === -1) return undefined;
  const n = Number(process.argv[i + 1] ?? '10');
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`${nome} espera um número entre 1 e 1000`);
  return n;
}

async function main(): Promise<void> {
  carregarEnvLocal();
  const repor = argNumero('--repor');
  const quantidade = repor ?? argNumero('--semear');
  if (repor) {
    const env = process.env;
    const destinoS3 = env.ARMAZENAMENTO_ENDPOINT?.trim() && env.ARMAZENAMENTO_ENDPOINT.trim() !== (env.LOCALSTACK_ENDPOINT?.trim() || 'http://127.0.0.1:4566');
    const destinoPg = env.DATABASE_URL_DESTINO?.trim() && env.DATABASE_URL?.trim() === env.DATABASE_URL_DESTINO.trim();
    if (destinoS3 || destinoPg) throw new Error('--repor só corre na origem (LocalStack e DATABASE_URL de origem)');
  }
  const deps = criarDependencias();
  try {
    console.log(`[exemplo-app] armazenamento: ${deps.armazenamento.descricao}`);
    await prepararEsquema(deps);
    if (repor) {
      const antigas = (await listarEncomendas(deps)).filter((e) => !e.cliente.startsWith('teste-'));
      // A fatura pode já não existir (LocalStack recriado): apagar no S3 uma chave em falta não falha.
      for (const e of antigas) await apagarEncomenda(deps, e);
      console.log(`[exemplo-app] apagadas ${antigas.length} encomendas semeadas antes`);
    }
    if (quantidade) {
      const criadas = await semear(deps, quantidade);
      console.log(`[exemplo-app] semeadas ${criadas.length} encomendas com fatura`);
      // Esvazia a fila dos eventos acabados de publicar, como faria o serviço que os consome.
      let consumidos = 0;
      while (consumidos < criadas.length) {
        const n = (await processarEventos(deps, 10)).length;
        if (n === 0) break;
        consumidos += n;
      }
      console.log(`[exemplo-app] eventos encomenda-criada consumidos: ${consumidos}`);
    }
    const encomendas = await listarEncomendas(deps);
    const faturas = await deps.armazenamento.listar(PREFIXO_FATURAS);
    console.log(`[exemplo-app] encomendas na base de dados: ${encomendas.length}; faturas no armazenamento: ${faturas.length}`);
  } finally {
    await fecharDependencias(deps);
  }
}

main().catch((erro) => {
  console.error('[exemplo-app]', erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
