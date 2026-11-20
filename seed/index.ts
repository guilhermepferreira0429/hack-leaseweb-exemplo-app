// Dados da seed (npm run seed) para o migrador e os testes: constantes, geradores e checksums.
// O que a seed gravou na origem está em ./esperado.json.
export * from './checksums';
export * from './dados';
export * from './cache';
export * from './segredos';
export { euros, gerarFaturaPdf, gerarFotoPng } from './ficheiros';
export type { ContextoFatura } from './ficheiros';
