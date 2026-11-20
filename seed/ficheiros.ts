// Ficheiros gerados sem bibliotecas: faturas em PDF 1.4 e fotos de produtos em PNG.
// Determinísticos (sem datas do relógio), para o sha256 de cada ficheiro ser sempre o mesmo.
// O tamanho vem de imagens RGB sem compressão: um carimbo "digitalizado" em cada fatura
// (~90-220 KB) e as fotos (~300-480 KB). Total dos dois buckets: ~300 MB.
import { deflateSync } from 'node:zlib';
import { Aleatorio, criarGrao } from './aleatorio';
import { EMPRESA } from './dados';
import type { Cliente, Encomenda, Fatura, LinhaEncomenda, Produto } from './dados';

// ---------------------------------------------------------------- dinheiro e texto

/** 123456 -> "1 234,56 €" (formato português, sem depender do ICU do Node). */
export function euros(centimos: number): string {
  const sinal = centimos < 0 ? '-' : '';
  const abs = Math.abs(centimos);
  const inteiros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sinal}${inteiros},${String(abs % 100).padStart(2, '0')} €`;
}

const EURO_WINANSI = String.fromCharCode(0x80);

/** Texto para dentro de ( ) num PDF com WinAnsiEncoding: Latin-1 + € em 0x80. */
function textoPdf(s: string): string {
  let r = '';
  for (const c of s) {
    const codigo = c.codePointAt(0)!;
    if (c === '€') r += EURO_WINANSI;
    else if (c === '(' || c === ')' || c === '\\') r += `\\${c}`;
    else if (codigo < 0x20 || codigo > 0xff) r += '?';
    else r += c;
  }
  return r;
}

// Larguras da Helvetica (1/1000 do tamanho) para alinhar valores à direita.
const LARGURAS: Record<string, number> = { ' ': 278, ',': 278, '.': 278, '-': 333, '%': 889, '€': 556 };
function largura(s: string, tamanho: number): number {
  let total = 0;
  for (const c of s) total += LARGURAS[c] ?? 556;
  return (total * tamanho) / 1000;
}

// ---------------------------------------------------------------- PDF

class Pagina {
  private ops: string[] = [];

  texto(x: number, y: number, s: string, tamanho = 10, negrito = false): this {
    this.ops.push(`BT /${negrito ? 'F2' : 'F1'} ${tamanho} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${textoPdf(s)}) Tj ET`);
    return this;
  }

  direita(xFim: number, y: number, s: string, tamanho = 10, negrito = false): this {
    return this.texto(xFim - largura(s, tamanho), y, s, tamanho, negrito);
  }

  linha(x1: number, y1: number, x2: number, y2: number, espessura = 0.5): this {
    this.ops.push(`${espessura} w ${x1} ${y1} m ${x2} ${y2} l S`);
    return this;
  }

  cor(r: number, g: number, b: number): this {
    this.ops.push(`${r} ${g} ${b} rg ${r} ${g} ${b} RG`);
    return this;
  }

  imagem(nome: string, x: number, y: number, w: number, h: number): this {
    this.ops.push(`q ${w} 0 0 ${h} ${x} ${y} cm /${nome} Do Q`);
    return this;
  }

  conteudo(): Buffer {
    return Buffer.from(this.ops.join('\n'), 'latin1');
  }
}

interface ImagemRgb {
  largura: number;
  altura: number;
  rgb: Buffer;
}

/** Monta o ficheiro PDF (uma página A4, Helvetica, uma imagem). */
function montarPdf(pagina: Pagina, imagem: ImagemRgb, titulo: string, dataPdf: string): Buffer {
  const conteudo = pagina.conteudo();
  const objetos: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R ' +
        '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 6 0 R >> >> >>',
      'latin1',
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${imagem.largura} /Height ${imagem.altura} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imagem.rgb.length} >>\nstream\n`,
        'latin1',
      ),
      imagem.rgb,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${conteudo.length} >>\nstream\n`, 'latin1'),
      conteudo,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.from(
      `<< /Title (${textoPdf(titulo)}) /Producer (exemplo-app seed) /CreationDate (D:${dataPdf}Z) >>`,
      'latin1',
    ),
  ];
  const partes: Buffer[] = [Buffer.from('%PDF-1.4\n%', 'latin1'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let posicao = partes.reduce((s, b) => s + b.length, 0);
  const deslocamentos: number[] = [];
  objetos.forEach((corpo, i) => {
    deslocamentos.push(posicao);
    const bloco = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), corpo, Buffer.from('\nendobj\n', 'latin1')]);
    partes.push(bloco);
    posicao += bloco.length;
  });
  const xref = [
    `xref\n0 ${objetos.length + 1}\n`,
    '0000000000 65535 f \n',
    ...deslocamentos.map((d) => `${String(d).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info ${objetos.length} 0 R >>\n`,
    `startxref\n${posicao}\n%%EOF\n`,
  ].join('');
  partes.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(partes);
}

/** Carimbo verde "digitalizado": anel sobre papel com grão. Lado em píxeis entre 170 e 270. */
function carimbo(semente: number): ImagemRgb {
  const r = new Aleatorio(semente);
  const lado = r.inteiro(170, 270);
  const grao = criarGrao(semente, 7);
  const rgb = Buffer.alloc(lado * lado * 3);
  const c = (lado - 1) / 2;
  const exterior = lado * 0.46;
  const interior = lado * 0.38;
  const tinta = 0.55 + r.proximo() * 0.4; // carimbos mais e menos carregados
  let i = 0;
  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const d = Math.hypot(x - c, y - c);
      const anel = d <= exterior && d >= interior;
      // Anel fino por dentro e uma estrela de cinco pontas ao centro.
      const anelFino = d <= lado * 0.33 && d >= lado * 0.31;
      const ang = Math.atan2(y - c, x - c);
      const faixa = d < lado * (0.12 + 0.1 * Math.abs(Math.cos((5 * ang) / 2)));
      const ruido = grao();
      if ((anel || anelFino || faixa) && r.proximo() < tinta) {
        rgb[i++] = 40 + ruido;
        rgb[i++] = 110 + ruido;
        rgb[i++] = 75 + ruido;
      } else {
        rgb[i++] = 246 + Math.min(ruido, 9);
        rgb[i++] = 244 + Math.min(ruido, 9);
        rgb[i++] = 236 + ruido;
      }
    }
  }
  return { largura: lado, altura: lado, rgb };
}

export interface ContextoFatura {
  fatura: Fatura;
  encomenda: Encomenda;
  cliente: Cliente;
  linhas: LinhaEncomenda[];
  produtos: Map<number, Produto>;
}

/** Fatura FT-2026-NNNN em PDF. Fictícia e marcada como tal no rodapé. */
export function gerarFaturaPdf({ fatura, encomenda, cliente, linhas, produtos }: ContextoFatura): Buffer {
  const p = new Pagina();
  const dataIso = encomenda.criadaEm.slice(0, 10);

  p.cor(0.16, 0.43, 0.29).texto(50, 785, EMPRESA.nome, 18, true).cor(0.2, 0.2, 0.2);
  p.texto(50, 768, `${EMPRESA.morada} · ${EMPRESA.codigoPostal} ${EMPRESA.localidade}`, 9);
  p.texto(50, 756, `NIF ${EMPRESA.nif} · ${EMPRESA.email}`, 9);
  p.imagem('Im1', 455, 712, 90, 90);

  p.cor(0, 0, 0).texto(50, 700, `FATURA ${fatura.numero}`, 15, true);
  p.texto(50, 682, `Data: ${dataIso}`, 10);
  p.texto(50, 668, `Encomenda: ${encomenda.numero}`, 10);
  p.texto(50, 654, `ATCUD: DEMO0000-${fatura.sequencia}`, 10);

  p.texto(320, 700, 'Cliente', 10, true);
  p.texto(320, 686, cliente.nome, 10);
  p.texto(320, 672, cliente.morada, 9);
  p.texto(320, 660, `${cliente.codigoPostal} ${cliente.localidade}`, 9);
  p.texto(320, 646, `NIF: ${cliente.nif}`, 9);

  let y = 600;
  p.texto(50, y, 'Artigo', 9, true).direita(380, y, 'Qtd.', 9, true).direita(450, y, 'Preço unit.', 9, true);
  p.direita(490, y, 'IVA', 9, true).direita(545, y, 'Total', 9, true);
  p.linha(50, y - 6, 545, y - 6);
  y -= 22;
  for (const l of linhas) {
    const produto = produtos.get(l.produtoId);
    const nome = produto ? `${produto.sku} ${produto.nome}` : `Produto ${l.produtoId}`;
    p.texto(50, y, nome.length > 58 ? `${nome.slice(0, 57)}…` : nome, 9);
    p.direita(380, y, String(l.quantidade), 9).direita(450, y, euros(l.precoUnitarioCentimos), 9);
    p.direita(490, y, `${l.taxaIva}%`, 9).direita(545, y, euros(l.subtotalCentimos), 9);
    y -= 16;
  }
  p.linha(330, y + 4, 545, y + 4);
  y -= 14;
  p.texto(340, y, 'Subtotal', 10).direita(545, y, euros(encomenda.subtotalCentimos), 10);
  y -= 16;
  p.texto(340, y, 'IVA', 10).direita(545, y, euros(encomenda.ivaCentimos), 10);
  y -= 20;
  p.texto(340, y, 'Total', 12, true).direita(545, y, euros(encomenda.totalCentimos), 12, true);

  p.cor(0.45, 0.45, 0.45);
  p.texto(50, 70, 'Pagamento por transferência bancária no prazo de 30 dias. Obrigado pela preferência.', 8);
  p.texto(50, 58, 'Documento fictício, sem validade fiscal: empresa, clientes e NIF inventados para demonstração.', 8);

  const dataPdf = encomenda.criadaEm.replace(/[-:T]/g, '').slice(0, 14);
  return montarPdf(p, carimbo(0x5eed0000 + fatura.sequencia), `Fatura ${fatura.numero}`, dataPdf);
}

// ---------------------------------------------------------------- PNG

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(dados: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function blocoPng(tipo: string, dados: Buffer): Buffer {
  const cab = Buffer.alloc(4);
  cab.writeUInt32BE(dados.length);
  const tipoEDados = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tipoEDados));
  return Buffer.concat([cab, tipoEDados, crc]);
}

/** PNG RGB 8 bits. Deflate nível 0 (blocos "stored"): tamanho previsível e geração rápida. */
function codificarPng(largura: number, altura: number, rgb: Buffer): Buffer {
  const linha = largura * 3;
  const cru = Buffer.alloc((linha + 1) * altura);
  for (let y = 0; y < altura; y++) {
    cru[y * (linha + 1)] = 0; // filtro "None"
    rgb.copy(cru, y * (linha + 1) + 1, y * linha, (y + 1) * linha);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    blocoPng('IHDR', ihdr),
    blocoPng('IDAT', deflateSync(cru, { level: 0 })),
    blocoPng('IEND', Buffer.alloc(0)),
  ]);
}

function hslParaRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const MATIZ_CATEGORIA: Record<string, number> = {
  Mercearia: 45, Conservas: 200, 'Café e Chá': 25, Vinhos: 345, Queijos: 50,
  Charcutaria: 10, Doces: 30, Higiene: 280, Casa: 160,
};

/** "Foto" de estúdio: fundo em degradê, o produto (frasco ou caixa) com luz e sombra, e grão. */
export function gerarFotoPng(produto: Produto, vista: number): Buffer {
  const semente = produto.id * 10 + vista;
  const r = new Aleatorio(0xf070 + semente);
  const lado = r.inteiro(300, 420);
  const grao = criarGrao(semente * 7919, 4);
  const matiz = (MATIZ_CATEGORIA[produto.categoria] ?? 0) + r.inteiro(-12, 12);
  const [fr1, fg1, fb1] = hslParaRgb(matiz, 0.25, 0.92);
  const [fr2, fg2, fb2] = hslParaRgb(matiz, 0.3, 0.78);
  const [pr, pg, pb] = hslParaRgb((matiz + 180 + r.inteiro(-40, 40)) % 360, 0.55, 0.42);
  const redondo = vista !== 2 && r.chance(0.5);
  const cx = lado / 2 + r.inteiro(-lado / 12, lado / 12);
  const larg = lado * (0.22 + r.proximo() * 0.1);
  const alt = lado * (0.3 + r.proximo() * 0.1);
  const topo = lado * 0.18;
  const base = topo + alt * 2;

  const rgb = Buffer.alloc(lado * lado * 3);
  let i = 0;
  for (let y = 0; y < lado; y++) {
    const t = y / (lado - 1);
    for (let x = 0; x < lado; x++) {
      let cr = fr1 + (fr2 - fr1) * t;
      let cg = fg1 + (fg2 - fg1) * t;
      let cb = fb1 + (fb2 - fb1) * t;
      // Sombra no chão.
      const sx = (x - cx) / (larg * 1.3);
      const sy = (y - base) / (lado * 0.035);
      const sombra = sx * sx + sy * sy;
      if (sombra < 1) {
        const k = 1 - 0.35 * (1 - sombra);
        cr *= k; cg *= k; cb *= k;
      }
      // O produto: elipse (frasco) ou retângulo de cantos redondos (caixa), com luz vinda da esquerda.
      const dx = (x - cx) / larg;
      const dy = (y - (topo + alt)) / alt;
      const dentro = redondo ? dx * dx + dy * dy <= 1 : Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && dx * dx * dx * dx + dy * dy * dy * dy <= 1.6;
      // Tampa (frasco) ou aba (caixa) por cima do produto.
      const tampa = Math.abs(x - cx) < larg * (redondo ? 0.45 : 0.9) && y >= topo - lado * 0.05 && y < topo + (redondo ? lado * 0.01 : -lado * 0.02);
      if (tampa) {
        cr = pr * 0.55; cg = pg * 0.55; cb = pb * 0.55;
      }
      if (dentro) {
        const luz = 0.75 + 0.45 * Math.max(0, 1 - Math.hypot(dx + 0.45, dy + 0.4));
        const rotulo = dy > -0.05 && dy < 0.45 && Math.abs(dx) < 0.62;
        const listra = rotulo && dy > 0.12 && dy < 0.18;
        cr = listra ? pr * 0.7 : rotulo ? 240 * luz : pr * luz;
        cg = listra ? pg * 0.7 : rotulo ? 234 * luz : pg * luz;
        cb = listra ? pb * 0.7 : rotulo ? 220 * luz : pb * luz;
      }
      const ruido = grao();
      rgb[i++] = Math.max(0, Math.min(255, Math.round(cr) + ruido));
      rgb[i++] = Math.max(0, Math.min(255, Math.round(cg) + ruido));
      rgb[i++] = Math.max(0, Math.min(255, Math.round(cb) + ruido));
    }
  }
  return codificarPng(lado, lado, rgb);
}
