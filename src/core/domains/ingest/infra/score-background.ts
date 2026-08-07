/**
 * Collection score background — the similarity scale of one collection.
 *
 * Search confidence needs to say "this result set scores high" without ever
 * naming an absolute number, because a raw cosine of 0.55 means whatever the
 * embedding model decides it means. The reference it measures against is the
 * collection's own similarity distribution: the cosine between random pairs of
 * stored vectors. A result set is then read as a z-score against that scale,
 * which survives an embedding-model swap the way a hard-coded threshold cannot.
 *
 * Same principle as `Reranker#computeAdaptiveBounds`, one level up: normalise
 * against the collection instead of against a constant.
 *
 * Sampled once per (re)index and persisted in the stats cache — see
 * `docs/superpowers/specs/2026-08-06-search-confidence-design.md`.
 */

import type { ScoreBackground } from "../../../contracts/types/trajectory.js";

/**
 * Below this many pairs the mean and stddev describe the sample rather than the
 * collection, and confidence built on them would be noise wearing a number.
 */
const MIN_PAIRS = 50;

/**
 * Pairwise-cosine background over sampled vectors. Vectors are consumed as
 * disjoint pairs in the order given — the caller supplies the sample, this
 * function does not decide sampling policy.
 *
 * Returns undefined when the sample is too small or carries no dispersion,
 * which callers must treat as "no confidence available" rather than as zero.
 */
export function computeScoreBackground(vectors: readonly number[][]): ScoreBackground | undefined {
  const arity = dominantArity(vectors);
  if (arity === undefined) return undefined;

  const usable = vectors.filter((v) => v.length === arity);
  const similarities: number[] = [];
  for (let i = 0; i + 1 < usable.length; i += 2) {
    similarities.push(cosine(usable[i], usable[i + 1]));
  }
  if (similarities.length < MIN_PAIRS) return undefined;

  const mean = similarities.reduce((sum, s) => sum + s, 0) / similarities.length;
  const variance = similarities.reduce((sum, s) => sum + (s - mean) ** 2, 0) / similarities.length;

  return { mean, stddev: Math.sqrt(variance), sampleCount: similarities.length };
}

/** The arity most vectors share — anything else is a malformed point, skipped. */
function dominantArity(vectors: readonly number[][]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of vectors) counts.set(v.length, (counts.get(v.length) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [arity, count] of counts) {
    if (arity > 0 && count > bestCount) {
      best = arity;
      bestCount = count;
    }
  }
  return best;
}

function cosine(a: readonly number[], b: readonly number[]): number {
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
