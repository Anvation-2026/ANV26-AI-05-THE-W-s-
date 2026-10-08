/** Small seeded generator. Same seed gives the same sequence on every machine. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knuth Poisson sampler, fine for the small per-second rates used here. */
export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 20);
  return k - 1;
}

export function pickClass<T extends string>(rng: Rng, mix: Record<T, number>, keys: readonly T[]): T {
  let r = rng();
  for (const k of keys) {
    r -= mix[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

/** Stable hash to a number in 0..1, used for deterministic visual jitter. */
export function hash01(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
