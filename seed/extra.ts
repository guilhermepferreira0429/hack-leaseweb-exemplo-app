// npm run seed:extra
// Serviços AWS que hoje ficam só no plano ("fase seguinte", decisão do Guilherme): DynamoDB, SNS e
// CloudWatch Logs no LocalStack. À parte do `npm run seed` para não atrasar os 5 que migram.
// Grava os checksums em seed/esperado-extra.json (o seed:comparar mostra-os se o ficheiro existir).
//
// Atenção: o SNS entrega numa fila SQS (encomendas-eventos-faturacao). Como é SQS, o migrarFila também a
// move para o RabbitMQ. Para a demo dos 5 serviços, não correr este comando.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carregarEnvLocal } from '../adaptadores';
import { checksumMensagens } from './checksums';
import { gerarDados } from './dados';
import { checksumItens, checksumTabelaDynamo, escreverDynamo, gerarDynamo } from './dynamo';
import type { ResumoDynamo } from './dynamo';
import { checksumEventos, escreverLogs, gerarLogs, lerGrupoLogs } from './logs';
import type { ResumoLogs } from './logs';
import { escreverSns, FILA_FATURACAO, gerarEventos } from './sns';
import type { ResumoTopico } from './sns';

export const CAMINHO_ESPERADO_EXTRA = fileURLToPath(new URL('./esperado-extra.json', import.meta.url));

export interface EsperadoExtra {
  nota: string;
  algoritmos: Record<'dynamodb' | 'sns' | 'fila' | 'logs', string>;
  dynamodb: Record<string, ResumoDynamo & { chaveParticao: { nome: string; tipo: 'S' | 'N' }; chaveOrdenacao?: { nome: string; tipo: 'S' | 'N' } }>;
  sns: ResumoTopico;
  filas: Record<string, { mensagens: number; checksum: string }>;
  logs: Record<string, ResumoLogs>;
}

async function main(): Promise<void> {
  carregarEnvLocal();
  const inicio = Date.now();
  const aws = { endpoint: process.env.LOCALSTACK_ENDPOINT?.trim() || 'http://127.0.0.1:4566', regiao: process.env.AWS_REGION?.trim() || 'us-east-1' };
  const dados = gerarDados();

  const tabelas = gerarDynamo(dados);
  await escreverDynamo(aws, tabelas);
  const dynamodb: EsperadoExtra['dynamodb'] = {};
  for (const t of tabelas) {
    const lido = await checksumTabelaDynamo(aws, t);
    const gerado = checksumItens(t, t.itens);
    if (lido.checksum !== gerado.checksum) throw new Error(`DynamoDB ${t.nome}: ${lido.itens} itens lidos não batem com os ${gerado.itens} gerados`);
    dynamodb[t.nome] = { ...lido, chaveParticao: t.chaveParticao, ...(t.chaveOrdenacao ? { chaveOrdenacao: t.chaveOrdenacao } : {}) };
  }

  const eventos = gerarEventos(dados);
  const { topico, entregues } = await escreverSns(aws, eventos);
  if (entregues !== eventos.length) throw new Error(`SNS: só ${entregues} de ${eventos.length} eventos chegaram à fila ${FILA_FATURACAO}`);

  const grupos = gerarLogs(dados);
  await escreverLogs(aws, grupos);
  const logs: EsperadoExtra['logs'] = {};
  for (const g of grupos) {
    const lido = await lerGrupoLogs(aws, g.nome);
    const gerado = checksumEventos(g.eventos);
    if (lido.checksum !== gerado.checksum) throw new Error(`CloudWatch Logs ${g.nome}: ${lido.eventos} eventos lidos não batem com os ${gerado.eventos} gerados`);
    logs[g.nome] = lido;
  }

  const esperado: EsperadoExtra = {
    nota: 'Serviços só no plano (fase seguinte): sem destino nem migração ao vivo hoje.',
    algoritmos: {
      dynamodb: 'sha256 das linhas "<chave>\\t<item AttributeValue em JSON canónico>\\n" ordenadas (seed/dynamo.ts)',
      sns: 'sha256 de "<tópico>\\n" e das subscrições "<protocolo>\\t<destino>\\n" ordenadas (seed/sns.ts)',
      fila: 'sha256 dos corpos das mensagens ordenados e unidos por "\\n"',
      logs: 'sha256 das linhas "<stream>\\t<timestamp ms>\\t<mensagem>\\n" ordenadas (seed/logs.ts)',
    },
    dynamodb,
    sns: topico,
    filas: { [FILA_FATURACAO]: { mensagens: entregues, checksum: checksumMensagens(eventos) } },
    logs,
  };
  writeFileSync(CAMINHO_ESPERADO_EXTRA, `${JSON.stringify(esperado, null, 2)}\n`);

  console.log('[seed:extra] contagens e checksums (só origem, fase seguinte)');
  for (const [n, t] of Object.entries(dynamodb)) console.log(`  ddb  ${n.padEnd(28)} ${String(t.itens).padStart(6)} itens        ${t.checksum}`);
  console.log(`  sns  ${topico.topico.padEnd(28)} ${String(topico.subscricoes).padStart(6)} subscrições  ${topico.checksum}`);
  console.log(`  sqs  ${FILA_FATURACAO.padEnd(28)} ${String(entregues).padStart(6)} mensagens    ${esperado.filas[FILA_FATURACAO]!.checksum}`);
  for (const [n, g] of Object.entries(logs)) console.log(`  logs ${n.padEnd(28)} ${String(g.eventos).padStart(6)} eventos      ${g.checksum}`);
  console.log(`[seed:extra] gravado em ${CAMINHO_ESPERADO_EXTRA}; ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
}

main().catch((erro) => {
  console.error('[seed:extra]', erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
