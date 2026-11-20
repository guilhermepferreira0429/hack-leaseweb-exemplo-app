// Os mesmos testes correm antes (AWS/LocalStack) e depois (Leaseweb/MinIO). Só mudam as variáveis de ambiente:
//   sem ARMAZENAMENTO_*            -> LocalStack (LOCALSTACK_ENDPOINT)
//   ARMAZENAMENTO_ENDPOINT=MinIO   -> Leaseweb (com ARMAZENAMENTO_ACCESS_KEY/SECRET_KEY)
// Sem a infraestrutura no ar (npm run infra:up) os testes são saltados, para o `npm test` de quem
// não tem Docker não ficar vermelho. Com VERIFICACAO_ESTRITA=1 (o migrador usa-o) nada é saltado.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { carregarEnvLocal } from '../adaptadores';
import { criarCache, lerCache } from '../cache';
import { carregarConfiguracao, criarSegredos } from '../segredos';
import {
  apagarEncomenda,
  criarDependencias,
  fecharDependencias,
  listarEncomendas,
  obterEncomenda,
  prepararEsquema,
  processarEventos,
  PREFIXO_FATURAS,
  registarEncomenda,
  sha256Hex,
} from '../app';
import type { Dependencias, Encomenda } from '../app';

carregarEnvLocal();
const ESTRITA = process.env.VERIFICACAO_ESTRITA === '1';
const PREFIXO_CLIENTE_TESTE = 'teste-';

/** null se a infraestrutura responde; senão, o motivo. */
async function sondar(): Promise<string | null> {
  let deps: Dependencias | undefined;
  try {
    deps = criarDependencias();
    const d = deps;
    const tempo = new Promise<never>((_, rejeitar) => setTimeout(() => rejeitar(new Error('sem resposta em 8 s')), 8000).unref());
    await Promise.race([Promise.all([d.baseDados.consultar('SELECT 1'), d.armazenamento.listar(PREFIXO_FATURAS)]), tempo]);
    return null;
  } catch (erro) {
    // Um bucket que ainda não existe não é falta de infraestrutura: o adaptador cria-o ao guardar.
    const estado = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (estado === 404) return null;
    return erro instanceof Error ? erro.message : String(erro);
  } finally {
    if (deps) await fecharDependencias(deps);
  }
}

const motivo = ESTRITA ? null : await sondar();
const salto = motivo ? `infraestrutura em baixo (npm run infra:up): ${motivo}` : false;

describe('exemplo-app (contrato igual em AWS e Leaseweb)', { skip: salto }, () => {
  let deps: Dependencias;
  const criadas: Encomenda[] = [];

  before(async () => {
    deps = criarDependencias();
    await prepararEsquema(deps);
  });

  after(async () => {
    if (!deps) return;
    for (const e of criadas) await apagarEncomenda(deps, e).catch(() => {});
    await fecharDependencias(deps);
  });

  const nova = async (): Promise<Encomenda> => {
    const fatura = Buffer.concat([Buffer.from('FATURA DE TESTE\n'), randomBytes(512)]);
    const e = await registarEncomenda(deps, { cliente: `${PREFIXO_CLIENTE_TESTE}${randomUUID()}`, totalCentimos: 1234, fatura });
    criadas.push(e);
    return e;
  };

  it('guarda e lê uma fatura no armazenamento com o mesmo sha256', async () => {
    const chave = `testes/${randomUUID()}.bin`;
    const conteudo = randomBytes(64 * 1024);
    await deps.armazenamento.guardar(chave, conteudo, 'application/octet-stream');
    try {
      const lido = await deps.armazenamento.ler(chave);
      assert.equal(sha256Hex(lido), sha256Hex(conteudo));
      assert.ok((await deps.armazenamento.listar('testes/')).includes(chave), 'a chave aparece na listagem');
    } finally {
      await deps.armazenamento.apagar(chave);
    }
  });

  it('regista uma encomenda e lê-a da base de dados', async () => {
    const e = await nova();
    const lida = await obterEncomenda(deps, e.id);
    assert.deepEqual(lida, e);
    const fatura = await deps.armazenamento.ler(e.faturaChave);
    assert.equal(sha256Hex(fatura), e.faturaSha256, 'a fatura guardada é a da encomenda');
    assert.equal(await obterEncomenda(deps, randomUUID()), undefined);
  });

  it('publica o evento encomenda-criada e consome-o da fila', async () => {
    const e = await nova();
    const vistos: string[] = [];
    for (let tentativa = 0; tentativa < 10 && !vistos.includes(e.id); tentativa++) {
      vistos.push(...(await processarEventos(deps, 10)));
    }
    assert.ok(vistos.includes(e.id), `o evento da encomenda ${e.id} chegou à fila`);
  });

  it('a contagem de encomendas semeadas bate certo depois da migração', async (t) => {
    const semeadas = (await listarEncomendas(deps)).filter((e) => !e.cliente.startsWith(PREFIXO_CLIENTE_TESTE));
    if (semeadas.length === 0) {
      if (ESTRITA) assert.fail('não há encomendas semeadas: npm run dev:exemplo -- --semear 20');
      t.skip('sem encomendas semeadas (npm run dev:exemplo -- --semear 20)');
      return;
    }
    // Cada encomenda da base de dados tem a sua fatura no armazenamento, com o sha256 de quando foi criada.
    const faturas = new Set(await deps.armazenamento.listar(PREFIXO_FATURAS));
    const emFalta = semeadas.filter((e) => !faturas.has(e.faturaChave)).map((e) => e.faturaChave);
    assert.deepEqual(emFalta, [], `faltam ${emFalta.length} de ${semeadas.length} faturas em ${deps.armazenamento.descricao}`);
    for (const e of semeadas) {
      assert.equal(sha256Hex(await deps.armazenamento.ler(e.faturaChave)), e.faturaSha256, `sha256 de ${e.faturaChave}`);
    }
  });
});

// Nível B: segredos (SEGREDOS_TIPO=aws|openbao) e cache (CACHE_TIPO=redis|valkey), no lado que as variáveis escolherem.
// Saltados se esse serviço não estiver configurado no .env; em VERIFICACAO_ESTRITA, configurado e em baixo é falha.
describe('exemplo-app: arranque com segredos e cache (nível B)', () => {
  it('arranca com a configuração lida dos segredos, sem a mostrar', async (t) => {
    let segredos;
    try {
      segredos = criarSegredos();
    } catch (erro) {
      t.skip(`segredos não configurados: ${erro instanceof Error ? erro.message : erro}`);
      return;
    }
    try {
      const cfg = await carregarConfiguracao(segredos);
      // Só verificações booleanas: um assert.equal com o valor mostrá-lo-ia ao falhar.
      assert.ok(cfg.fornecedor.length > 0 && cfg.endpoint.length > 0, 'fornecedor e endpoint presentes');
      assert.ok(cfg.apiKey.length > 0, `apiKey presente (${segredos.descricao})`);
    } catch (erro) {
      if (!ESTRITA && erro instanceof Error && /não responde|não existe|Não consegui ler/.test(erro.message)) {
        t.skip(`${segredos.descricao}: ${erro.message}`);
        return;
      }
      throw erro;
    } finally {
      await segredos.fechar();
    }
  });

  it('guarda e lê uma encomenda na cache, com TTL', async (t) => {
    try {
      lerCache();
    } catch (erro) {
      t.skip(`cache não configurada: ${erro instanceof Error ? erro.message : erro}`);
      return;
    }
    let cache;
    try {
      cache = await criarCache();
    } catch (erro) {
      if (!ESTRITA) {
        t.skip(`cache em baixo: ${erro instanceof Error ? erro.message : erro}`);
        return;
      }
      throw erro;
    }
    const chave = `teste:encomenda:${randomUUID()}`;
    try {
      const valor = JSON.stringify({ id: chave, cliente: 'Café Central — Ç', totalCentimos: 1234 });
      await cache.guardar(chave, valor, 60);
      assert.equal(await cache.ler(chave), valor);
      await cache.apagar(chave);
      assert.equal(await cache.ler(chave), null);
    } finally {
      await cache.apagar(chave).catch(() => {});
      await cache.fechar();
    }
  });
});
