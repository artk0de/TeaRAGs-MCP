/**
 * Otsu's 1-D split: the cut that best separates a sample into two classes.
 *
 * Pure arithmetic with one consumer today (the leaking-abstraction detector's
 * adaptive adoption threshold, bd tea-rags-mcp-jetrd). It lives beside that
 * consumer rather than in `core/infra/`, whose criterion is "needed by at
 * least two layers" (`.claude/rules/domain-boundaries.md`); it has no import
 * of its own, so moving it there when a second layer needs it is a file move.
 */

/** The best two-class cut of a sample. */
export interface OtsuSplit {
  /** Midpoint of `lowerValue` and `upperValue` — where the cut is drawn. */
  threshold: number;
  /** The largest value of the lower class. */
  lowerValue: number;
  /** The smallest value of the upper class. */
  upperValue: number;
  /**
   * η = σ²between / σ²total in [0, 1]: how much of the sample's variance the
   * cut explains. Near 1 = two well-separated modes; low = one mode cut in two.
   */
  separability: number;
}

/**
 * Otsu's split over `values`: sort, and at every cut between two DISTINCT
 * consecutive values compute the between-class variance `w0·w1·(μ0−μ1)²`
 * (class weights as fractions of the sample); keep the maximum — the first one
 * on a tie, so the result is deterministic. Ties in the sample never straddle
 * the cut. `null` when the sample has fewer than two distinct values.
 */
export function otsuSplit(values: readonly number[]): OtsuSplit | null {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0 || sorted[0] === sorted[n - 1]) return null;
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const mean = total / n;
  const totalVariance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;

  let best: { between: number; index: number } | undefined;
  let lowerSum = 0;
  for (let i = 0; i < n - 1; i++) {
    lowerSum += sorted[i];
    if (sorted[i] === sorted[i + 1]) continue;
    const n0 = i + 1;
    const w0 = n0 / n;
    const w1 = 1 - w0;
    const mu0 = lowerSum / n0;
    const mu1 = (total - lowerSum) / (n - n0);
    const between = w0 * w1 * (mu0 - mu1) ** 2;
    if (best === undefined || between > best.between) best = { between, index: i };
  }
  // Two distinct values guarantee at least one cut.
  const { between, index } = best as { between: number; index: number };
  const lowerValue = sorted[index];
  const upperValue = sorted[index + 1];
  return {
    threshold: (lowerValue + upperValue) / 2,
    lowerValue,
    upperValue,
    separability: between / totalVariance,
  };
}
