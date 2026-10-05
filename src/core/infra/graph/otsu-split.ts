/**
 * Otsu's 1-D split: the cut that best separates a sample into two classes,
 * with the majority-floored policy that turns the cut into a threshold — and
 * the separability gate that refuses the cut when the sample is not bimodal
 * enough for one to mean anything (bd tea-rags-mcp-r8hme.46).
 *
 * Pure arithmetic, foundation home (`core/infra/graph/`, beside Tarjan SCC,
 * PageRank and the weight-threshold clustering). The contract — "an adaptive
 * threshold drawn from the population it judges, floored and gated" — is
 * consumed by several sibling subdomains that may not import each other, so
 * the foundation is their only legal shared home
 * (`.claude/rules/domain-boundaries.md`); which detectors those are is each
 * detector's own documentation, not this module's. The module has no import
 * of its own.
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
 * The separability gate on Otsu's cut: the cut's η = σ²between / σ²total must
 * reach this for the policy to trust it as a split of two modes; below it the
 * population is one mode as far as the evidence goes, and the policy resolves
 * to the majority floor (bd tea-rags-mcp-r8hme.46). Not an env knob.
 *
 * Calibrated, not guessed. η is the fraction of the sample's variance the
 * cut's two classes explain, and its anchors are exact:
 *
 * - one uniform mass reads η = 0.75 at its median cut — the arbitrary
 *   halving of a single mode this gate exists to refuse — so the gate must
 *   sit strictly above 0.75;
 * - two equal Gaussian modes kσ apart read η ≈ 0.68 / 0.74 / 0.81 / 0.86 at
 *   k = 2 / 3 / 4 / 5 (Monte Carlo, 2·10⁵ draws), so 0.8 is "separated at
 *   least like two equal modes 4σ apart": between-class variance at least
 *   4× the within-class variance the cut leaves behind;
 * - the two registered corpora measured η ∈ [0.718, 0.823] over their nine
 *   live cuts (tea-rags: adoption 0.823, distance 0.776, volatility 0.727,
 *   strength 0.755, shared-neighbour 0.718, norms 0.742; taxdome: strength
 *   0.757, shared-neighbour 0.793, the ninth unreported at filing) — one
 *   cut clears the gate, the rest fall to their documented floors.
 */
export const OTSU_SEPARABILITY_GATE = 0.8;

/**
 * A threshold drawn from the population it judges, never below a fixed floor:
 * Otsu's cut when the population is large enough, varied enough AND bimodal
 * enough (η at or above {@link OTSU_SEPARABILITY_GATE}) to trust one; the
 * floor alone otherwise. Under either method a value at or below the floor is
 * never admitted.
 */
export interface MajorityFlooredOtsuThreshold {
  method: "otsu" | "majority";
  /** The Otsu cut when `method` is `otsu`; the floor otherwise. */
  threshold: number;
  /**
   * η of the Otsu cut — present whenever one was computed: under `otsu` as
   * the cut's evidence, under `majority` as the rejection evidence (the
   * measured η that fell below the gate). Absent only when no split was
   * computed at all: population below `minPopulation`, or fewer than two
   * distinct values.
   */
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
 * least `minPopulation` values, two distinct ones, and a cut whose η reaches
 * {@link OTSU_SEPARABILITY_GATE}; the strict `majority` otherwise. The floor
 * holds under both: Otsu can only raise the bar, because a population with
 * its gap below the floor would otherwise admit values the floor exists to
 * refuse.
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
  if (split.separability < OTSU_SEPARABILITY_GATE) {
    return {
      method: "majority",
      threshold: majority,
      separability: split.separability,
      admits: aboveMajority,
    };
  }
  return {
    method: "otsu",
    threshold: split.threshold,
    separability: split.separability,
    admits: (value) => value >= split.threshold && aboveMajority(value),
  };
}
