// Checksums que o seed grava em esperado.json e que o migrador recalcula no destino.
// As mesmas funções servem a origem (LocalStack) e o destino (MinIO / Postgres da Leaseweb).
//   bucket: sha256 das linhas "<chave>\t<sha256 do objeto>\n", por ordem de chave (só as chaves do filtro)
//   tabela: sha256 de string_agg(linha::text, '\n' ORDER BY id), calculado no próprio Postgres, em UTC
//   fila:   sha256 dos corpos das mensagens ordenados, separados por '\n' (a ordem do SQS não é garantida)
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';

export function sha256Hex(conteudo: Uint8Array | string): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ResumoBucket {
  objetos: number;
  bytes: number;
  checksum: string;
}

/** Checksum de um conjunto de objetos já com o sha256 de cada um. */
export function checksumObjetos(itens: { chave: string; sha256: string; bytes: number }[]): ResumoBucket {
  const ordenados = [...itens].sort((a, b) => porCodigo(a.chave, b.chave));
  const h = createHash('sha256');
  for (const o of ordenados) h.update(`${o.chave}\t${o.sha256}\n`);
  return { objetos: itens.length, bytes: itens.reduce((s, o) => s + o.bytes, 0), checksum: h.digest('hex') };
}

/** Lê do bucket todos os objetos cujo nome passa no filtro e calcula o checksum. */
export async function checksumBucket(s3: S3Client, bucket: string, filtro: RegExp, emParalelo = 8): Promise<ResumoBucket> {
  const chaves: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key && filtro.test(o.Key)) chaves.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  const itens: { chave: string; sha256: string; bytes: number }[] = [];
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    while (proximo < chaves.length) {
      const chave = chaves[proximo++]!;
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
      if (!r.Body) throw new Error(`Objeto sem corpo: ${bucket}/${chave}`);
      const corpo = await r.Body.transformToByteArray();
      itens.push({ chave, sha256: sha256Hex(corpo), bytes: corpo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(emParalelo, chaves.length) }, trabalhador));
  return checksumObjetos(itens);
}

export interface ResumoTabela {
  linhas: number;
  checksum: string;
}

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

/**
 * Contagem e checksum de uma tabela, calculados no Postgres. Usa um cliente dedicado (não um pool),
 * porque fixa o fuso horário e o formato das datas na sessão: assim o texto de cada linha é igual
 * em qualquer servidor.
 */
export async function checksumTabela(cliente: pg.ClientBase, esquema: string, tabela: string): Promise<ResumoTabela> {
  if (!IDENTIFICADOR.test(esquema) || !IDENTIFICADOR.test(tabela)) throw new Error(`nome inválido: ${esquema}.${tabela}`);
  await cliente.query("SET TIME ZONE 'UTC'");
  await cliente.query("SET DateStyle = 'ISO, YMD'");
  const r = await cliente.query<{ linhas: number; checksum: string }>(
    `SELECT count(*)::int AS linhas,
            encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' ORDER BY t.id), ''), 'UTF8')), 'hex') AS checksum
       FROM "${esquema}"."${tabela}" t`,
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`sem resultado para ${esquema}.${tabela}`);
  return { linhas: linha.linhas, checksum: linha.checksum };
}

export function checksumMensagens(corpos: string[]): string {
  return sha256Hex([...corpos].sort(porCodigo).join('\n'));
}
