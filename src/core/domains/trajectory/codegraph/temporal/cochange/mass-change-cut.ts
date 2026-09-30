/**
 * The adaptive mass-change cut (bd tea-rags-mcp-x4rpp).
 *
 * A bundle touching many files — a rename sweep, a formatter run, a dependency
 * bump — pairs every file with every other and says nothing about which of them
 * belong together. Where "many" starts is a property of the repository: a team
 * of 3-file commits and an agent workflow of 30-file commits need different
 * cuts, so no constant fits both (the 9szed gate's 15 was taxdome's).
 *
 * The cut is Tukey's upper outlier fence, `Q3 + 1.5·IQR`, drawn over log2 of the
 * sizes of bundles with at least two files. Commit sizes are heavy-tailed; on
 * the log scale their bulk is roughly symmetric, which is where the fence means
 * "outlier". Single-file bundles carry no pair and would pull the quartiles
 * down to 1, so they are left out of the sample.
 */

/**
 * Memory ceiling, not a noise judgement: a bundle of n files adds n(n−1)/2 pair
 * increments, so 64 bounds one bundle at 2016 whatever the corpus says.
 */
export const MASS_CHANGE_CEILING = 64;

/** Smallest meaningful cut — a pair needs two files. */
const MIN_CUT = 2;

/**
 * Tukey's upper outlier fence over log2 of a sample, as an inclusive cut:
 * `floor(2^(Q3 + 1.5·IQR))` clamped to `[bounds.min, bounds.max]`. Sample
 * entries below 2 are left out first — they carry no pair and would pull the
 * quartiles down to 1 (the file level: single-file bundles; the intra-file
 * fence: single-symbol commits). An empty sample answers `bounds.max`: with
 * nothing pair-bearing observed there is no evidence for a cut below the
 * ceiling. The shared Tukey of the temporal family — file bundles
 * (`computeMassChangeCut`) and the cohesion fence over a file's own commits.
 */
export function tukeyCutOverLog2(sample: readonly number[], bounds: { min: number; max: number }): number {
  const logs = sample
    .filter((n) => n >= 2)
    .map((n) => Math.log2(n))
    .sort((a, b) => a - b);
  if (logs.length === 0) return bounds.max;
  const q1 = quantile(logs, 0.25);
  const q3 = quantile(logs, 0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(2 ** fence)));
}

/** Largest admitted bundle size for `bundleFileCounts` (every bundle's distinct-file count). */
export function computeMassChangeCut(bundleFileCounts: readonly number[]): number {
  return tukeyCutOverLog2(bundleFileCounts, { min: MIN_CUT, max: MASS_CHANGE_CEILING });
}

/** Linear-interpolated quantile (type 7) of an ascending sample. */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
