/**
 * Otsu's 1-D split: the cut that best separates a sample into two classes.
 *
 * Pure arithmetic with two consumers, both boundary detectors of the codegraph
 * trajectory: the leaking-abstraction detector's adaptive adoption threshold
 * (bd tea-rags-mcp-jetrd) and the temporal silent-coupling detector's
 * strength threshold (bd tea-rags-mcp-b4dcz), which reaches it through this
 * directory's barrel. It stays in the codegraph domain rather than
 * `core/infra/`, whose criterion is "needed by at least two layers"
 * (`.claude/rules/domain-boundaries.md`); it has no import of its own, so
 * moving it there when a second layer needs it is a file move.
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

/**
 * A threshold drawn from the population it judges, never below a fixed floor:
 * Otsu's cut when the population is large and varied enough to trust one, the
 * floor alone otherwise, and under either method a value at or below the floor
 * is never admitted.
 */
export interface MajorityFlooredOtsuThreshold {
  method: "otsu" | "majority";
  /** The Otsu cut when `method` is `otsu`; the floor otherwise. */
  threshold: number;
  /** η of the Otsu cut; absent under `majority`. */
  separability?: number;
  /** Whether a value clears the threshold — `>= threshold` AND strictly `> majority`. */
  admits: (value: number) => boolean;
}

export interface MajorityFlooredOtsuOptions {
  /** The floor; a value must be STRICTLY above it. */
  majority: number;
  /** Smallest population Otsu's split is trusted on. */
  minPopulation: number;
}

/**
 * Resolve the threshold over `population`: {@link otsuSplit} when it holds at
 * least `minPopulation` values and two distinct ones, the strict `majority`
 * otherwise. The floor holds under both: Otsu can only raise the bar, because
 * a population with its gap below the floor would otherwise admit values the
 * floor exists to refuse.
 */
export function resolveMajorityFlooredOtsuThreshold(
  population: readonly number[],
  options: MajorityFlooredOtsuOptions,
): MajorityFlooredOtsuThreshold {
  const { majority, minPopulation } = options;
  const aboveMajority = (value: number) => value > majority;
  const split = population.length >= minPopulation ? otsuSplit(population) : null;
  if (split === null) {
    return { method: "majority", threshold: majority, admits: aboveMajority };
  }
  return {
    method: "otsu",
    threshold: split.threshold,
    separability: split.separability,
    admits: (value) => value >= split.threshold && aboveMajority(value),
  };
}
