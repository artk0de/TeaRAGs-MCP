/**
 * Vector arithmetic shared by everything that compares embeddings.
 *
 * One numeric kernel, not one per caller: the collection score background and
 * the embedding-model canary both measure the same thing, and two copies drift
 * the moment one of them is tuned.
 */

/**
 * Cosine similarity of two equal-length vectors, 0 when either has no
 * magnitude.
 *
 * Length is the CALLER's contract: this loops over `a` and reads `b` at the
 * same indices, so a shorter `b` yields NaN. What a length difference means is
 * a domain question — the score background filters the sample to one arity, the
 * model guard treats a width change as a different model — and neither answer
 * belongs in the arithmetic.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
