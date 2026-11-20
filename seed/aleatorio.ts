// Gerador pseudo-aleatório com semente fixa (mulberry32): os mesmos números em qualquer máquina.
// Cada tipo de dados tem o seu fluxo (filho('clientes'), filho('produtos')...), para que mudar
// um gerador não desloque os números dos outros.

/** FNV-1a de 32 bits: transforma um rótulo num número para derivar sementes. */
function fnv1a(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Aleatorio {
  private estado: number;

  constructor(private readonly semente: number) {
    this.estado = semente >>> 0;
  }

  /** Número em [0, 1). */
  proximo(): number {
    let t = (this.estado = (this.estado + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inteiro em [min, max], os dois incluídos. */
  inteiro(min: number, max: number): number {
    return min + Math.floor(this.proximo() * (max - min + 1));
  }

  escolher<T>(lista: readonly T[]): T {
    if (lista.length === 0) throw new Error('escolher() numa lista vazia');
    return lista[Math.floor(this.proximo() * lista.length)]!;
  }

  chance(p: number): boolean {
    return this.proximo() < p;
  }

  /** Baralha uma cópia (Fisher-Yates). */
  baralhar<T>(lista: readonly T[]): T[] {
    const copia = [...lista];
    for (let i = copia.length - 1; i > 0; i--) {
      const j = Math.floor(this.proximo() * (i + 1));
      [copia[i], copia[j]] = [copia[j]!, copia[i]!];
    }
    return copia;
  }

  /** Fluxo independente, derivado desta semente e de um rótulo. */
  filho(rotulo: string): Aleatorio {
    return new Aleatorio(fnv1a(`${this.semente}:${rotulo}`));
  }
}

/** Ruído rápido para píxeis (xorshift32). Devolve inteiros em [-amplitude, amplitude]. */
export function criarGrao(semente: number, amplitude: number): () => number {
  let x = (semente >>> 0) || 0x9e3779b9;
  const largura = amplitude * 2 + 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x % largura) - amplitude;
  };
}
