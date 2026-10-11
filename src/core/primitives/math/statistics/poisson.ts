/**
 * The Poisson upper tail, resolved in log space (bd tea-rags-mcp-xb669.8).
 *
 * Lifted from the co-change pair gate (bd tea-rags-mcp-89k7k.1.14), whose
 * upper tail judges a pair co-changing MORE than its configuration null
 * predicts. The foundation is its home so every trajectory sub-domain reads
 * the same math without reaching into another's internals — the same reason
 * Otsu's split lives in `primitives/graph`.
 */

import { logGamma } from "./log-gamma.js";

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
