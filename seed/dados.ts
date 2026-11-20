// Dados falsos mas credíveis de uma PME portuguesa de encomendas ("Encomendas Lusas, Lda.").
// Tudo é inventado e determinístico: a mesma SEMENTE dá sempre os mesmos clientes, produtos,
// encomendas, faturas e mensagens. Nada de dados pessoais reais:
//   - nomes e moradas são combinações de listas genéricas;
//   - os NIF têm 9 dígitos e dígito de controlo válido, mas começam por 49, um prefixo que a AT
//     não atribui (singulares 1/2/3, não residentes 45, coletivas 5, públicas 6, 7x, 8, 9x);
//   - os emails usam o domínio reservado .example (RFC 2606), que nunca entrega correio.
import { Aleatorio } from './aleatorio';

export const SEMENTE = 20261120;
/** Fim do período de 12 meses. Fixo, para os dados não mudarem consoante o dia em que se corre. */
export const DATA_REFERENCIA = '2026-11-19T23:59:59Z';
export const ESQUEMA = 'loja';
export const BUCKET_FATURAS = 'faturas';
export const BUCKET_FOTOS = 'fotos-produtos';
export const FILA_ENCOMENDAS = 'encomendas-novas';
export const QUANTIDADES = { clientes: 500, produtos: 120, encomendas: 5000, faturas: 1200, fotos: 300, mensagens: 50 } as const;
/** Só estes objetos contam para o checksum do bucket (a app pode lá ter outros, em faturas/). */
export const FILTRO_FATURAS = /^FT-2026-\d{4}\.pdf$/;
export const FILTRO_FOTOS = /^PRD-\d{4}-\d\.png$/;

export const EMPRESA = {
  nome: 'Encomendas Lusas, Lda.',
  morada: 'Rua do Armazém Imaginário, 100',
  codigoPostal: '4000-000',
  localidade: 'Porto',
  nif: '490000002',
  email: 'geral@encomendas-lusas.example',
};

export type EstadoEncomenda = 'nova' | 'paga' | 'enviada' | 'entregue' | 'cancelada';

export interface Cliente {
  id: number;
  tipo: 'particular' | 'empresa';
  nome: string;
  nif: string;
  email: string;
  morada: string;
  codigoPostal: string;
  localidade: string;
  distrito: string;
  /** AAAA-MM-DD */
  criadoEm: string;
}

export interface Produto {
  id: number;
  sku: string;
  nome: string;
  categoria: string;
  precoCentimos: number;
  /** 6, 13 ou 23 (%). */
  taxaIva: number;
  stock: number;
  fotos: number;
}

export interface Encomenda {
  id: number;
  numero: string;
  clienteId: number;
  /** ISO 8601 em UTC. */
  criadaEm: string;
  estado: EstadoEncomenda;
  subtotalCentimos: number;
  ivaCentimos: number;
  totalCentimos: number;
  faturaNumero: string | null;
}

export interface LinhaEncomenda {
  id: number;
  encomendaId: number;
  produtoId: number;
  quantidade: number;
  precoUnitarioCentimos: number;
  taxaIva: number;
  subtotalCentimos: number;
  ivaCentimos: number;
}

export interface Foto {
  chave: string;
  produtoId: number;
  vista: number;
}

export interface Fatura {
  chave: string;
  numero: string;
  /** Posição na série (1..1200), usada no ATCUD fictício. */
  sequencia: number;
  encomendaId: number;
}

export interface DadosLoja {
  clientes: Cliente[];
  produtos: Produto[];
  encomendas: Encomenda[];
  linhas: LinhaEncomenda[];
  faturas: Fatura[];
  fotos: Foto[];
  /** Corpos JSON das mensagens da fila encomendas-novas. */
  mensagens: string[];
}

// ---------------------------------------------------------------- listas

const NOMES_F = ['Maria', 'Ana', 'Beatriz', 'Carolina', 'Inês', 'Joana', 'Mariana', 'Sofia', 'Leonor', 'Matilde', 'Rita', 'Catarina', 'Teresa', 'Helena', 'Marta', 'Patrícia', 'Sara', 'Filipa', 'Raquel', 'Luísa'];
const NOMES_M = ['João', 'José', 'António', 'Francisco', 'Manuel', 'Pedro', 'Tiago', 'Rui', 'Miguel', 'Duarte', 'Tomás', 'Gonçalo', 'Diogo', 'Ricardo', 'Nuno', 'Paulo', 'Bruno', 'Hugo', 'André', 'Luís'];
const APELIDOS = ['Silva', 'Santos', 'Ferreira', 'Pereira', 'Oliveira', 'Costa', 'Rodrigues', 'Martins', 'Jesus', 'Sousa', 'Fernandes', 'Gonçalves', 'Gomes', 'Lopes', 'Marques', 'Alves', 'Almeida', 'Ribeiro', 'Pinto', 'Carvalho', 'Teixeira', 'Moreira', 'Correia', 'Mendes', 'Nunes', 'Soares', 'Vieira', 'Monteiro', 'Cardoso', 'Rocha', 'Neves', 'Coelho', 'Cruz', 'Cunha', 'Pires', 'Ramos', 'Reis', 'Simões', 'Antunes', 'Matos', 'Fonseca', 'Machado', 'Araújo', 'Barbosa', 'Tavares', 'Lourenço', 'Castro', 'Figueiredo', 'Azevedo', 'Freitas'];
const NEGOCIOS = ['Mercearia', 'Padaria', 'Café', 'Restaurante', 'Talho', 'Pastelaria', 'Minimercado', 'Loja Gourmet', 'Tasca', 'Hotel', 'Garrafeira', 'Charcutaria'];
const SUFIXOS_EMPRESA = ['Lda.', 'Unipessoal, Lda.', 'S.A.', '& Filhos, Lda.'];
const TIPOS_RUA = ['Rua', 'Rua', 'Rua', 'Avenida', 'Travessa', 'Largo', 'Praceta', 'Estrada'];
const NOMES_RUA = ['das Flores', 'do Comércio', 'da Liberdade', 'dos Pescadores', 'da Igreja', 'do Mercado', 'das Oliveiras', 'do Sol', 'da Fonte', 'dos Moinhos', 'da Escola', 'do Castelo', 'das Camélias', 'do Rossio', 'da Estação', 'dos Lavradores', 'das Amoreiras', 'do Pinhal', 'da Boavista', 'do Outeiro', 'das Hortas', 'da Ribeira', 'dos Combatentes', 'Nova', 'Direita', 'de Baixo', 'do Calvário', 'das Eiras', 'do Cruzeiro', 'da Alegria'];
const ANDARES = ['', '', '', ', 1.º Esq.', ', 2.º Dto.', ', R/C', ', 3.º Frente', ', Loja A'];
// [localidade, distrito, prefixo do código postal, peso]
const LOCALIDADES: [string, string, number, number][] = [
  ['Lisboa', 'Lisboa', 1000, 14], ['Porto', 'Porto', 4000, 12], ['Vila Nova de Gaia', 'Porto', 4400, 6], ['Matosinhos', 'Porto', 4450, 4],
  ['Braga', 'Braga', 4700, 6], ['Guimarães', 'Braga', 4800, 3], ['Coimbra', 'Coimbra', 3000, 5], ['Aveiro', 'Aveiro', 3800, 4],
  ['Leiria', 'Leiria', 2400, 3], ['Viseu', 'Viseu', 3500, 3], ['Setúbal', 'Setúbal', 2900, 3], ['Almada', 'Setúbal', 2800, 3],
  ['Faro', 'Faro', 8000, 3], ['Portimão', 'Faro', 8500, 2], ['Évora', 'Évora', 7000, 2], ['Santarém', 'Santarém', 2000, 2],
  ['Viana do Castelo', 'Viana do Castelo', 4900, 2], ['Vila Real', 'Vila Real', 5000, 2], ['Bragança', 'Bragança', 5300, 1],
  ['Castelo Branco', 'Castelo Branco', 6000, 1], ['Guarda', 'Guarda', 6300, 1], ['Beja', 'Beja', 7800, 1], ['Portalegre', 'Portalegre', 7300, 1],
  ['Funchal', 'Madeira', 9000, 2], ['Ponta Delgada', 'Açores', 9500, 1], ['Sintra', 'Lisboa', 2710, 4], ['Cascais', 'Lisboa', 2750, 3],
  ['Oeiras', 'Lisboa', 2780, 3], ['Amadora', 'Lisboa', 2700, 2], ['Loures', 'Lisboa', 2670, 2],
];
const MARCAS = ['Quinta do Vale Sereno', 'Casa Albergaria', 'Moinho da Ribeira', 'Serra Alta', 'Monte Imaginário', 'Terras do Sul', 'Herdade Lusitana'];

// [nome, categoria, IVA %, preço base em cêntimos, 4 variantes com multiplicador de preço]
type Base = [string, string, number, number, [string, number][]];
const CATALOGO: Base[] = [
  ['Azeite Virgem Extra', 'Mercearia', 6, 650, [['250 ml', 0.45], ['500 ml', 0.8], ['750 ml', 1], ['3 l', 3.4]]],
  ['Conserva de Sardinha', 'Conservas', 6, 290, [['em azeite 120 g', 1], ['picante 120 g', 1.05], ['com limão 120 g', 1.1], ['pack 3 x 120 g', 2.7]]],
  ['Conserva de Atum', 'Conservas', 6, 340, [['em azeite 120 g', 1], ['ao natural 120 g', 0.95], ['posta 200 g', 1.8], ['pack 3 x 120 g', 2.7]]],
  ['Mel de Rosmaninho', 'Mercearia', 6, 590, [['250 g', 0.6], ['500 g', 1], ['1 kg', 1.85], ['favo 400 g', 1.6]]],
  ['Compota', 'Mercearia', 6, 360, [['de abóbora 250 g', 1], ['de figo 250 g', 1.1], ['de laranja 250 g', 1], ['de ginja 250 g', 1.2]]],
  ['Arroz Carolino', 'Mercearia', 6, 189, [['1 kg', 1], ['2 kg', 1.9], ['5 kg', 4.4], ['agulha 1 kg', 0.95]]],
  ['Grão-de-bico', 'Mercearia', 6, 165, [['seco 500 g', 1], ['seco 1 kg', 1.85], ['cozido 400 g', 0.75], ['biológico 500 g', 1.6]]],
  ['Farinha de Trigo', 'Mercearia', 6, 99, [['tipo 65 1 kg', 1], ['tipo 55 1 kg', 1.05], ['integral 1 kg', 1.4], ['milho 1 kg', 1.2]]],
  ['Café Moído', 'Café e Chá', 23, 450, [['250 g', 1], ['500 g', 1.85], ['descafeinado 250 g', 1.1], ['grão 1 kg', 3.3]]],
  ['Chá', 'Café e Chá', 23, 320, [['verde 20 saquetas', 1], ['preto 20 saquetas', 0.95], ['de cidreira 20 saquetas', 0.9], ['de camomila 20 saquetas', 0.9]]],
  ['Vinho Tinto Douro', 'Vinhos', 13, 790, [['colheita 75 cl', 1], ['reserva 75 cl', 1.9], ['magnum 1,5 l', 2.2], ['caixa 6 x 75 cl', 5.6]]],
  ['Vinho Verde', 'Vinhos', 13, 590, [['branco 75 cl', 1], ['rosé 75 cl', 1.05], ['alvarinho 75 cl', 1.7], ['caixa 6 x 75 cl', 5.6]]],
  ['Vinho do Porto', 'Vinhos', 13, 1290, [['tawny 75 cl', 1], ['ruby 75 cl', 0.95], ['10 anos 75 cl', 2.1], ['branco 75 cl', 1]]],
  ['Queijo de Ovelha', 'Queijos', 6, 990, [['amanteigado 500 g', 1], ['curado 400 g', 0.9], ['mini 250 g', 0.55], ['peça 1 kg', 1.9]]],
  ['Queijo de Cabra', 'Queijos', 6, 790, [['fresco 200 g', 0.5], ['curado 400 g', 1], ['com pimenta 400 g', 1.1], ['peça 1 kg', 2.3]]],
  ['Chouriço', 'Charcutaria', 6, 450, [['de carne 250 g', 1], ['de porco preto 250 g', 1.6], ['picante 250 g', 1.05], ['corrente 1 kg', 3.6]]],
  ['Presunto', 'Charcutaria', 6, 690, [['fatiado 100 g', 1], ['fatiado 200 g', 1.9], ['de porco preto 100 g', 1.8], ['peça 1 kg', 4.5]]],
  ['Bolachas de Manteiga', 'Doces', 23, 280, [['200 g', 1], ['400 g', 1.85], ['com canela 200 g', 1.1], ['lata 500 g', 2.9]]],
  ['Pastéis de Massa Tenra', 'Doces', 23, 590, [['caixa 6', 1], ['caixa 12', 1.9], ['congelados 6', 0.9], ['congelados 12', 1.7]]],
  ['Amêndoa Coberta', 'Doces', 23, 490, [['branca 200 g', 1], ['com canela 200 g', 1.05], ['de chocolate 200 g', 1.15], ['saco 1 kg', 4.4]]],
  ['Flor de Sal', 'Mercearia', 6, 390, [['150 g', 1], ['com ervas 150 g', 1.2], ['frasco 250 g', 1.5], ['saco 1 kg', 4]]],
  ['Massa', 'Mercearia', 6, 109, [['esparguete 500 g', 1], ['cotovelinhos 500 g', 1], ['letrinhas 250 g', 0.7], ['integral 500 g', 1.4]]],
  ['Sabonete Artesanal', 'Higiene', 23, 450, [['de alfazema', 1], ['de azeite', 1], ['de laranja', 1], ['caixa 3', 2.7]]],
  ['Creme de Mãos', 'Higiene', 23, 690, [['de amêndoa 50 ml', 1], ['de azeite 50 ml', 1], ['de rosas 50 ml', 1.1], ['100 ml', 1.7]]],
  ['Pano de Cozinha', 'Casa', 23, 590, [['algodão', 1], ['linho', 1.6], ['conjunto 3', 2.6], ['bordado', 1.9]]],
  ['Caneca de Cerâmica', 'Casa', 23, 890, [['azul', 1], ['verde', 1], ['amarela', 1], ['conjunto 4', 3.6]]],
  ['Prato de Barro', 'Casa', 23, 1190, [['raso 26 cm', 1], ['fundo 22 cm', 0.95], ['travessa 35 cm', 1.9], ['conjunto 6', 5.4]]],
  ['Base de Cortiça', 'Casa', 23, 390, [['redonda', 1], ['quadrada', 1], ['conjunto 4', 3.2], ['para tachos grande', 1.6]]],
  ['Sacos Reutilizáveis', 'Casa', 23, 250, [['algodão', 1], ['juta', 1.4], ['pack 3', 2.6], ['para fruta 5', 1.8]]],
  ['Velas Aromáticas', 'Casa', 23, 790, [['de alfazema', 1], ['de figo', 1], ['de pinho', 1], ['conjunto 3', 2.7]]],
];

// ---------------------------------------------------------------- utilitários

/** Dígito de controlo do NIF (pesos 9..2, módulo 11). */
export function digitoControloNif(oitoDigitos: string): number {
  let soma = 0;
  for (let i = 0; i < 8; i++) soma += Number(oitoDigitos[i]) * (9 - i);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function nifValido(nif: string): boolean {
  return /^\d{9}$/.test(nif) && digitoControloNif(nif.slice(0, 8)) === Number(nif[8]);
}

function semAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function emailDe(nome: string, n: number): string {
  const partes = semAcentos(nome).toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
  const local = partes.length > 1 ? `${partes[0]}.${partes[partes.length - 1]}` : (partes[0] ?? 'cliente');
  return `${local}${n}@correio.example`;
}

function data(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DIA_MS = 86_400_000;

function escolherPesado<T>(r: Aleatorio, itens: readonly [T, number][]): T {
  const total = itens.reduce((s, [, p]) => s + p, 0);
  let x = r.proximo() * total;
  for (const [item, peso] of itens) {
    x -= peso;
    if (x < 0) return item;
  }
  return itens[itens.length - 1]![0];
}

// ---------------------------------------------------------------- geradores

function gerarClientes(r: Aleatorio): Cliente[] {
  const nifs = new Set<string>([EMPRESA.nif]);
  const clientes: Cliente[] = [];
  const inicio = Date.parse('2023-01-01T00:00:00Z');
  const fim = Date.parse('2025-11-01T00:00:00Z');
  for (let id = 1; id <= QUANTIDADES.clientes; id++) {
    const empresa = r.chance(0.18);
    let nome: string;
    if (empresa) {
      nome = `${r.escolher(NEGOCIOS)} ${r.escolher(APELIDOS)} ${r.escolher(SUFIXOS_EMPRESA)}`;
    } else {
      const proprio = r.chance(0.5) ? r.escolher(NOMES_F) : r.escolher(NOMES_M);
      nome = `${proprio} ${r.escolher(APELIDOS)} ${r.escolher(APELIDOS)}`;
    }
    let nif: string;
    do {
      const base = `49${String(r.inteiro(0, 999_999)).padStart(6, '0')}`;
      nif = `${base}${digitoControloNif(base)}`;
    } while (nifs.has(nif));
    nifs.add(nif);
    const [localidade, distrito, prefixo] = escolherPesado(r, LOCALIDADES.map(([l, d, p, w]) => [[l, d, p] as const, w]));
    clientes.push({
      id,
      tipo: empresa ? 'empresa' : 'particular',
      nome,
      nif,
      email: emailDe(nome, id),
      morada: `${r.escolher(TIPOS_RUA)} ${r.escolher(NOMES_RUA)}, ${r.inteiro(1, 250)}${r.escolher(ANDARES)}`,
      codigoPostal: `${prefixo + r.inteiro(0, 99)}-${String(r.inteiro(1, 999)).padStart(3, '0')}`,
      localidade,
      distrito,
      criadoEm: data(inicio + Math.floor(r.proximo() * (fim - inicio))),
    });
  }
  return clientes;
}

function gerarProdutos(r: Aleatorio): Produto[] {
  const produtos: Produto[] = [];
  let id = 0;
  for (const [nome, categoria, taxaIva, preco, variantes] of CATALOGO) {
    const marca = r.escolher(MARCAS);
    for (const [variante, mult] of variantes) {
      id++;
      // Preços "de prateleira": terminam em 9 cêntimos.
      const precoCentimos = Math.max(49, Math.round((preco * mult * (0.9 + r.proximo() * 0.2)) / 10) * 10 - 1);
      produtos.push({
        id,
        sku: `PRD-${String(id).padStart(4, '0')}`,
        nome: `${nome} ${variante} ${marca}`,
        categoria,
        precoCentimos,
        taxaIva,
        stock: r.inteiro(0, 400),
        // 120 produtos, 300 fotos: os 60 primeiros têm 3 vistas, os outros 2.
        fotos: id <= QUANTIDADES.fotos - 2 * QUANTIDADES.produtos ? 3 : 2,
      });
    }
  }
  if (produtos.length !== QUANTIDADES.produtos) throw new Error(`catálogo com ${produtos.length} produtos`);
  return produtos;
}

function gerarEncomendas(r: Aleatorio, clientes: Cliente[], produtos: Produto[]) {
  const fim = Date.parse(DATA_REFERENCIA);
  const inicio = fim - 365 * DIA_MS;
  // Datas: horário de loja (08h-22h, hora de Lisboa ~ UTC), mais encomendas em dezembro.
  const instantes: number[] = [];
  while (instantes.length < QUANTIDADES.encomendas) {
    const dia = Math.floor(inicio / DIA_MS) * DIA_MS + Math.floor(r.proximo() * 365) * DIA_MS + DIA_MS;
    const mes = new Date(dia).getUTCMonth();
    if (mes !== 11 && !r.chance(0.8)) continue;
    const t = dia + r.inteiro(8 * 3600, 21 * 3600 + 3599) * 1000;
    if (t > fim) continue;
    instantes.push(t);
  }
  instantes.sort((a, b) => a - b);

  const encomendas: Encomenda[] = [];
  const linhas: LinhaEncomenda[] = [];
  const ultimas = QUANTIDADES.encomendas - QUANTIDADES.mensagens;
  for (let i = 0; i < instantes.length; i++) {
    const id = i + 1;
    const t = instantes[i]!;
    // Poucos clientes compram muito; muitos compram pouco.
    const cliente = clientes[Math.floor(r.proximo() ** 2 * clientes.length)]!;
    const estado: EstadoEncomenda =
      i >= ultimas ? 'nova' : r.chance(0.04) ? 'cancelada' : fim - t < 5 * DIA_MS ? 'paga' : fim - t < 10 * DIA_MS ? 'enviada' : 'entregue';
    const escolhidos = r.baralhar(produtos).slice(0, escolherPesado(r, [[1, 30], [2, 30], [3, 20], [4, 12], [5, 8]]));
    let subtotal = 0;
    let iva = 0;
    for (const p of escolhidos) {
      const quantidade = escolherPesado(r, [[1, 45], [2, 25], [3, 12], [4, 8], [6, 6], [12, 4]]);
      const sub = quantidade * p.precoCentimos;
      const ivaLinha = Math.round((sub * p.taxaIva) / 100);
      subtotal += sub;
      iva += ivaLinha;
      linhas.push({
        id: linhas.length + 1,
        encomendaId: id,
        produtoId: p.id,
        quantidade,
        precoUnitarioCentimos: p.precoCentimos,
        taxaIva: p.taxaIva,
        subtotalCentimos: sub,
        ivaCentimos: ivaLinha,
      });
    }
    encomendas.push({
      id,
      numero: `ENC-${String(id).padStart(6, '0')}`,
      clienteId: cliente.id,
      criadaEm: new Date(t).toISOString(),
      estado,
      subtotalCentimos: subtotal,
      ivaCentimos: iva,
      totalCentimos: subtotal + iva,
      faturaNumero: null,
    });
  }
  return { encomendas, linhas };
}

/** Série FT-2026: 1.200 encomendas de 2026 já pagas, numeradas por ordem cronológica. */
function gerarFaturas(r: Aleatorio, encomendas: Encomenda[]): Fatura[] {
  const elegiveis = encomendas.filter((e) => e.criadaEm >= '2026-01-01' && ['paga', 'enviada', 'entregue'].includes(e.estado));
  const escolhidas = r.baralhar(elegiveis).slice(0, QUANTIDADES.faturas).sort((a, b) => a.id - b.id);
  if (escolhidas.length !== QUANTIDADES.faturas) throw new Error(`só há ${escolhidas.length} encomendas para faturar`);
  return escolhidas.map((e, i) => {
    const numero = `FT-2026-${String(i + 1).padStart(4, '0')}`;
    e.faturaNumero = numero;
    return { chave: `${numero}.pdf`, numero, sequencia: i + 1, encomendaId: e.id };
  });
}

function gerarMensagens(encomendas: Encomenda[], linhas: LinhaEncomenda[]): string[] {
  const porEncomenda = new Map<number, LinhaEncomenda[]>();
  for (const l of linhas) porEncomenda.set(l.encomendaId, [...(porEncomenda.get(l.encomendaId) ?? []), l]);
  return encomendas
    .filter((e) => e.estado === 'nova')
    .map((e) =>
      JSON.stringify({
        tipo: 'encomenda-nova',
        encomenda: e.numero,
        encomendaId: e.id,
        clienteId: e.clienteId,
        criadaEm: e.criadaEm,
        totalCentimos: e.totalCentimos,
        linhas: (porEncomenda.get(e.id) ?? []).map((l) => ({ produtoId: l.produtoId, quantidade: l.quantidade })),
      }),
    );
}

/** Gera tudo a partir da semente. Função pura: chamá-la duas vezes dá o mesmo resultado. */
export function gerarDados(semente = SEMENTE): DadosLoja {
  const raiz = new Aleatorio(semente);
  const clientes = gerarClientes(raiz.filho('clientes'));
  const produtos = gerarProdutos(raiz.filho('produtos'));
  const { encomendas, linhas } = gerarEncomendas(raiz.filho('encomendas'), clientes, produtos);
  const faturas = gerarFaturas(raiz.filho('faturas'), encomendas);
  const fotos: Foto[] = produtos.flatMap((p) =>
    Array.from({ length: p.fotos }, (_, i) => ({ chave: `${p.sku}-${i + 1}.png`, produtoId: p.id, vista: i + 1 })),
  );
  const mensagens = gerarMensagens(encomendas, linhas);
  return { clientes, produtos, encomendas, linhas, faturas, fotos, mensagens };
}
