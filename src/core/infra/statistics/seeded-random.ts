/**
 * Seeded randomness for the statistical tests (bd tea-rags-mcp-dm61n). A
 * sampled p-value must be reproducible run to run, so every draw comes from a
 * PRNG seeded from the data it judges — never from the clock, and never from
 * the order the caller happens to evaluate things in.
 */

/** Small deterministic PRNG (mulberry32), uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over the key's UTF-16 code units — a seed derived from data. */
export function seedFromKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
