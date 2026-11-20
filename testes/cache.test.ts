// Adaptador de cache da exemplo-app nos dois lados (CACHE_TIPO=redis e valkey), com chaves temporárias.
// O lado que não estiver no ar (npm run infra:up) ou sem URL no .env é saltado.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { carregarEnvLocal } from '../adaptadores';
import { criarCache, lerCache, type TipoCache } from '../cache';

carregarEnvLocal();
const PREFIXO = `exemplo-teste-${randomBytes(4).toString('hex')}`;

async function sondar(tipo: TipoCache): Promise<string | false> {
  try {
    const c = await criarCache({ ...process.env, CACHE_TIPO: tipo });
    await c.fechar();
    return false;
  } catch (erro) {
    return `${tipo} indisponível: ${erro instanceof Error ? erro.message : erro}`;
  }
}

for (const tipo of ['redis', 'valkey'] as const) {
  const salto = await sondar(tipo);
  describe(`exemplo-app: cache (${tipo})`, { skip: salto }, () => {
    it('guarda, lê, expira e apaga', async () => {
      const c = await criarCache({ ...process.env, CACHE_TIPO: tipo });
      const chave = `${PREFIXO}:${tipo}`;
      try {
        assert.match(c.descricao, new RegExp(`^${tipo} 127\\.0\\.0\\.1:\\d+$`));
        await c.guardar(chave, 'Café Central — Ç', 60);
        assert.equal(await c.ler(chave), 'Café Central — Ç');
        await c.apagar(chave);
        assert.equal(await c.ler(chave), null);
      } finally {
        await c.apagar(chave).catch(() => {});
        await c.fechar();
      }
    });
  });
}

describe('exemplo-app: cache (configuração)', () => {
  it('por omissão é o Redis de origem', () => {
    assert.deepEqual(lerCache({ REDIS_ORIGEM_URL: 'redis://127.0.0.1:6380' }), { tipo: 'redis', url: 'redis://127.0.0.1:6380' });
  });

  it('CACHE_TIPO=valkey usa o VALKEY_URL', () => {
    assert.equal(lerCache({ CACHE_TIPO: 'valkey', VALKEY_URL: 'redis://127.0.0.1:6381' }).url, 'redis://127.0.0.1:6381');
  });

  it('erros claros', () => {
    assert.throws(() => lerCache({ CACHE_TIPO: 'valkey' }), { message: 'VALKEY_URL não está definida no .env' });
    assert.throws(() => lerCache({ REDIS_ORIGEM_URL: 'redis://:<senha>@127.0.0.1:6380' }), {
      message: 'REDIS_ORIGEM_URL não está definida no .env',
    });
    assert.throws(() => lerCache({ CACHE_TIPO: 'memcached' }), /CACHE_TIPO desconhecido/);
  });

  it('servidor em baixo: diz qual e onde, sem a senha', async () => {
    await assert.rejects(criarCache({ CACHE_TIPO: 'valkey', VALKEY_URL: 'redis://:segredo@127.0.0.1:1' }), {
      message: 'Valkey não responde em 127.0.0.1:1',
    });
  });
});
