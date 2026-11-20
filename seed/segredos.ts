// Configuração e segredos FALSOS da loja no Secrets Manager e no SSM Parameter Store (LocalStack).
// Todos os valores sensíveis começam por "demo-falso-": não servem para nada fora desta demo.
// Os nomes de host usam domínios .example (RFC 2606), que nunca resolvem.
//
// Checksum: sha256 das linhas "nome\tvalor\n" (Secrets Manager) ou "nome\ttipo\tvalor\n" (SSM),
// por ordem de nome. Só se escreve o checksum no esperado.json, nunca os valores.
import { createHash } from 'node:crypto';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParametersByPathCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { GetParametersByPathCommandOutput } from '@aws-sdk/client-ssm';
import { Aleatorio } from './aleatorio';
import { BUCKET_FATURAS, BUCKET_FOTOS, EMPRESA, FILA_ENCOMENDAS, SEMENTE } from './dados';

export const PREFIXO_SEGREDOS = 'encomendas/prod/';
export const PREFIXO_PARAMETROS = '/encomendas/prod/';
export const MARCA_FALSO = 'demo-falso-';

export interface Segredo {
  nome: string;
  descricao: string;
  /** SecretString: JSON ou texto simples. */
  valor: string;
}

export type TipoParametro = 'String' | 'StringList' | 'SecureString';

export interface Parametro {
  nome: string;
  tipo: TipoParametro;
  valor: string;
}

export function gerarSegredos(semente = SEMENTE): { segredos: Segredo[]; parametros: Parametro[] } {
  const r = new Aleatorio(semente).filho('segredos');
  const falso = (n = 24): string => `${MARCA_FALSO}${Array.from({ length: n }, () => r.inteiro(0, 35).toString(36)).join('')}`;
  const senhaBd = falso(28);
  const chavePagamentos = falso(32);

  const segredos: Segredo[] = [
    {
      nome: `${PREFIXO_SEGREDOS}base-dados`,
      descricao: 'Credenciais do RDS PostgreSQL da app de encomendas (FALSAS, demo)',
      valor: JSON.stringify({ engine: 'postgres', host: 'encomendas-prod.rds.example', port: 5432, dbname: 'encomendas', username: 'app_encomendas', password: senhaBd }),
    },
    {
      nome: `${PREFIXO_SEGREDOS}api-pagamentos`,
      descricao: 'Chaves do fornecedor de pagamentos (FALSAS, demo)',
      valor: JSON.stringify({ fornecedor: 'PagamentosDemo', endpoint: 'https://api.pagamentos.example/v1', apiKey: chavePagamentos, webhookSecret: falso(32) }),
    },
    {
      nome: `${PREFIXO_SEGREDOS}smtp`,
      descricao: 'Conta SMTP que envia as faturas (FALSA, demo)',
      valor: JSON.stringify({ host: 'smtp.correio.example', port: 587, user: `faturas@${EMPRESA.email.split('@')[1]}`, password: falso(20) }),
    },
    {
      nome: `${PREFIXO_SEGREDOS}jwt-assinatura`,
      descricao: 'Chave de assinatura das sessões (FALSA, demo)',
      valor: falso(48),
    },
  ];

  const p = (nome: string, tipo: TipoParametro, valor: string): Parametro => ({ nome: `${PREFIXO_PARAMETROS}${nome}`, tipo, valor });
  const parametros: Parametro[] = [
    p('app/nome', 'String', EMPRESA.nome),
    p('app/moeda', 'String', 'EUR'),
    p('app/idioma', 'String', 'pt-PT'),
    p('app/log-nivel', 'String', 'info'),
    p('app/iva-taxas', 'StringList', '6,13,23'),
    p('app/funcionalidades', 'StringList', 'checkout-rapido,faturas-pdf,fotos-produtos'),
    p('s3/bucket-faturas', 'String', BUCKET_FATURAS),
    p('s3/bucket-fotos', 'String', BUCKET_FOTOS),
    p('sqs/fila-encomendas', 'String', FILA_ENCOMENDAS),
    p('limites/encomenda-max-centimos', 'String', '500000'),
    p('db/password', 'SecureString', senhaBd),
    p('pagamentos/api-key', 'SecureString', chavePagamentos),
  ];
  return { segredos, parametros };
}

// ---------------------------------------------------------------- checksum

const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ResumoSegredos {
  itens: number;
  checksum: string;
}

export function checksumSegredos(itens: { nome: string; valor: string }[]): ResumoSegredos {
  const h = createHash('sha256');
  for (const s of [...itens].sort((a, b) => porCodigo(a.nome, b.nome))) h.update(`${s.nome}\t${s.valor}\n`);
  return { itens: itens.length, checksum: h.digest('hex') };
}

export function checksumParametros(itens: Parametro[]): ResumoSegredos {
  const h = createHash('sha256');
  for (const s of [...itens].sort((a, b) => porCodigo(a.nome, b.nome))) h.update(`${s.nome}\t${s.tipo}\t${s.valor}\n`);
  return { itens: itens.length, checksum: h.digest('hex') };
}

// ---------------------------------------------------------------- LocalStack

export interface LigacaoAws {
  endpoint: string;
  regiao: string;
}

const credenciais = { accessKeyId: 'test', secretAccessKey: 'test' }; // convenção do LocalStack, não é segredo

export async function escreverSegredos(aws: LigacaoAws, dados: { segredos: Segredo[]; parametros: Parametro[] }): Promise<void> {
  const sm = new SecretsManagerClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  const ssm = new SSMClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  try {
    for (const s of dados.segredos) {
      try {
        await sm.send(new CreateSecretCommand({ Name: s.nome, Description: s.descricao, SecretString: s.valor }));
      } catch (erro) {
        if ((erro as Error).name !== 'ResourceExistsException') throw erro;
        await sm.send(new PutSecretValueCommand({ SecretId: s.nome, SecretString: s.valor }));
      }
    }
    for (const p of dados.parametros) {
      await ssm.send(new PutParameterCommand({ Name: p.nome, Type: p.tipo, Value: p.valor, Overwrite: true }));
    }
  } finally {
    sm.destroy();
    ssm.destroy();
  }
}

/** Lê do LocalStack os segredos e parâmetros da seed (pelos prefixos) e calcula os checksums. */
export async function lerSegredosAws(aws: LigacaoAws): Promise<{ segredos: ResumoSegredos; parametros: ResumoSegredos }> {
  const sm = new SecretsManagerClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  const ssm = new SSMClient({ endpoint: aws.endpoint, region: aws.regiao, credentials: credenciais, maxAttempts: 2 });
  try {
    const nomes: string[] = [];
    let token: string | undefined;
    do {
      const r = await sm.send(new ListSecretsCommand({ NextToken: token, MaxResults: 100 }));
      for (const s of r.SecretList ?? []) if (s.Name?.startsWith(PREFIXO_SEGREDOS)) nomes.push(s.Name);
      token = r.NextToken;
    } while (token);
    const segredos: { nome: string; valor: string }[] = [];
    for (const nome of nomes) {
      const v = await sm.send(new GetSecretValueCommand({ SecretId: nome }));
      segredos.push({ nome, valor: v.SecretString ?? '' });
    }

    const parametros: Parametro[] = [];
    token = undefined;
    do {
      const r: GetParametersByPathCommandOutput = await ssm.send(new GetParametersByPathCommand({ Path: PREFIXO_PARAMETROS, Recursive: true, WithDecryption: true, NextToken: token }));
      for (const p of r.Parameters ?? []) {
        if (p.Name && p.Type) parametros.push({ nome: p.Name, tipo: p.Type as TipoParametro, valor: p.Value ?? '' });
      }
      token = r.NextToken;
    } while (token);

    return { segredos: checksumSegredos(segredos), parametros: checksumParametros(parametros) };
  } finally {
    sm.destroy();
    ssm.destroy();
  }
}

// ---------------------------------------------------------------- OpenBao (destino)
// Mapeamento do migrador (KV v2 em secret/):
//   Secrets Manager <nome>  -> secret/data/aws/secretsmanager/<nome>
//   SSM /<caminho>          -> secret/data/aws/ssm/<caminho sem a / inicial>
//   data: { valor: "<string exata>", tipo: "<tipo>" }

export interface LigacaoOpenBao {
  endereco: string;
  token: string;
}

export const RAIZ_OPENBAO = { segredos: `aws/secretsmanager/${PREFIXO_SEGREDOS}`, parametros: `aws/ssm/${PREFIXO_PARAMETROS.slice(1)}` };

async function bao(lig: LigacaoOpenBao, metodo: 'GET' | 'LIST' | 'DELETE', caminho: string): Promise<Record<string, unknown> | null> {
  const url = new URL(`/v1/${caminho}`, lig.endereco);
  if (metodo === 'LIST') url.searchParams.set('list', 'true');
  const r = await fetch(url, {
    method: metodo === 'LIST' ? 'GET' : metodo,
    headers: { 'X-Vault-Token': lig.token },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return null;
  // Nunca se mostra o corpo da resposta (podia ter valores) nem o token.
  if (!r.ok) throw new Error(`OpenBao respondeu ${r.status} a ${metodo} ${caminho}${r.status === 403 ? ' (token recusado)' : ''}`);
  return r.status === 204 ? {} : ((await r.json()) as Record<string, unknown>);
}

/** Caminhos (relativos a secret/) de todas as folhas debaixo de uma raiz do KV v2. */
async function listarFolhas(lig: LigacaoOpenBao, raiz: string): Promise<string[]> {
  const r = await bao(lig, 'LIST', `secret/metadata/${raiz}`);
  const chaves = ((r?.data as { keys?: string[] } | undefined)?.keys ?? []);
  const folhas: string[] = [];
  for (const k of chaves) {
    if (k.endsWith('/')) folhas.push(...(await listarFolhas(lig, `${raiz}${k}`)));
    else folhas.push(`${raiz}${k}`);
  }
  return folhas;
}

export async function lerSegredosOpenBao(lig: LigacaoOpenBao): Promise<{ segredos: ResumoSegredos; parametros: ResumoSegredos }> {
  const ler = async (caminho: string): Promise<{ valor: string; tipo: string }> => {
    const r = await bao(lig, 'GET', `secret/data/${caminho}`);
    const d = ((r?.data as { data?: { valor?: unknown; tipo?: unknown } } | undefined)?.data ?? {});
    return { valor: String(d.valor ?? ''), tipo: String(d.tipo ?? '') };
  };
  const segredos: { nome: string; valor: string }[] = [];
  for (const c of await listarFolhas(lig, RAIZ_OPENBAO.segredos)) {
    segredos.push({ nome: c.slice('aws/secretsmanager/'.length), valor: (await ler(c)).valor });
  }
  const parametros: Parametro[] = [];
  for (const c of await listarFolhas(lig, RAIZ_OPENBAO.parametros)) {
    const { valor, tipo } = await ler(c);
    parametros.push({ nome: `/${c.slice('aws/ssm/'.length)}`, tipo: tipo as TipoParametro, valor });
  }
  return { segredos: checksumSegredos(segredos), parametros: checksumParametros(parametros) };
}

/** Apaga do OpenBao (todas as versões) só os segredos e parâmetros da seed. Devolve quantos apagou. */
export async function apagarSegredosOpenBao(lig: LigacaoOpenBao, apagar: boolean): Promise<number> {
  const folhas = [...(await listarFolhas(lig, RAIZ_OPENBAO.segredos)), ...(await listarFolhas(lig, RAIZ_OPENBAO.parametros))];
  if (apagar) for (const c of folhas) await bao(lig, 'DELETE', `secret/metadata/${c}`);
  return folhas.length;
}
