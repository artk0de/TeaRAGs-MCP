/**
 * Poisson tails, each side resolved in log space (bd tea-rags-mcp-xb669.8).
 *
 * Lifted from the co-change pair gate (bd tea-rags-mcp-89k7k.1.14), whose
 * upper tail judges a pair co-changing MORE than its configuration null
 * predicts; the dependency norms judge a role pair occurring LESS than
 * independence of roles predicts with the lower tail. Two trajectory
 * sub-domains read the same math and neither may reach the other's internals,
 * so the foundation is its home — the same reason Otsu's split lives in
 * `infra/graph`.
 */

/** Lanczos (g = 7, n = 9) log Γ(x), x > 0. */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let sum = c[0];
  for (let i = 1; i < 9; i++) sum += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Ample for any λ a corpus produces; the series terminate far earlier. */
const POISSON_SERIES_TERM_CAP = 1_000_000;

/** log P(X ≥ s), summed upward from the term at s. Accurate where s > λ. */
function logUpperTermsSum(support: number, lambda: number): number {
  const logFirst = -lambda + support * Math.log(lambda) - logGamma(support + 1);
  let sum = 1;
  let term = 1;
  for (let k = support; k < support + POISSON_SERIES_TERM_CAP; k++) {
    term *= lambda / (k + 1);
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return logFirst + Math.log(sum);
}

/** log P(X ≤ s), summed downward from the term at s. Accurate where s < λ. */
function logLowerTermsSum(support: number, lambda: number): number {
  const logLast = -lambda + support * Math.log(lambda) - logGamma(support + 1);
  let sum = 1;
  let term = 1;
  for (let k = support; k > 0; k--) {
    term *= k / lambda;
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return logLast + Math.log(sum);
}

/**
 * P(X ≥ s), X ~ Poisson(λ). The smaller side is summed in log space so a far
 * tail is resolved rather than rounded to 0, and a near-certain tail is not
 * computed as 1 minus a sum that has lost its digits: s > λ sums the upper
 * terms from s upward; s ≤ λ sums the lower terms from s − 1 downward and
 * subtracts.
 */
export function poissonUpperTail(support: number, lambda: number): number {
  if (support <= 0) return 1;
  if (!(lambda > 0)) return 0;
  if (support === 1) return -Math.expm1(-lambda);
  if (support > lambda) return Math.min(1, Math.exp(logUpperTermsSum(support, lambda)));
  return Math.max(0, -Math.expm1(logLowerTermsSum(support - 1, lambda)));
}

/**
 * P(X ≤ s), X ~ Poisson(λ) — the mirror of {@link poissonUpperTail}: s < λ
 * sums the lower terms from s downward; s ≥ λ sums the upper terms from s + 1
 * upward and subtracts. λ = 0 puts all mass at 0.
 */
export function poissonLowerTail(support: number, lambda: number): number {
  if (support < 0) return 0;
  if (!(lambda > 0)) return 1;
  if (support < lambda) return Math.min(1, Math.exp(logLowerTermsSum(support, lambda)));
  return Math.max(0, -Math.expm1(logUpperTermsSum(support + 1, lambda)));
}
