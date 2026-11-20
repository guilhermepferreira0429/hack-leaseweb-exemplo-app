// Dados da seed (npm run seed) para o migrador e os testes: constantes, geradores e checksums.
// O que a seed gravou na origem está em ./esperado.json.
export * from './checksums';
export * from './dados';
export * from './cache';
export * from './segredos';
export { checksumItens, checksumTabelaDynamo, gerarDynamo, jsonCanonico } from './dynamo';
export type { ResumoDynamo, TabelaDynamo } from './dynamo';
export { checksumTopico, FILA_FATURACAO, gerarEventos, lerTopico, TOPICO_EVENTOS } from './sns';
export type { ResumoTopico } from './sns';
export { checksumEventos, gerarLogs, lerGrupoLogs } from './logs';
export type { EventoLog, GrupoLogs, ResumoLogs } from './logs';
export { euros, gerarFaturaPdf, gerarFotoPng } from './ficheiros';
export type { ContextoFatura } from './ficheiros';
