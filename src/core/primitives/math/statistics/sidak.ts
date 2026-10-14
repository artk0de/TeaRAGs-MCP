/**
 * Šidák correction of a minimum p-value (bd tea-rags-mcp-v4279), lifted into
 * primitives so any detector that keeps the best of several tests reports the
 * chance of that best, not of one test.
 */

/**
 * The family-wise p of the smallest of `comparisons` independent p-values:
 * 1 − (1 − pMin)^k, the chance that at least one of k null tests lands at or
 * below `pMin`. Computed as −expm1(k·log1p(−pMin)) so a tiny pMin keeps its
 * digits (≈ k·pMin) instead of rounding 1 − (1 − pMin)^k to 0. Fewer than one
 * comparison is one — a single test needs no correction.
 */
export function sidakCorrectedMinimumPValue(pMin: number, comparisons: number): number {
  if (pMin >= 1) return 1;
  if (pMin <= 0) return 0;
  return -Math.expm1(Math.max(1, comparisons) * Math.log1p(-pMin));
}
