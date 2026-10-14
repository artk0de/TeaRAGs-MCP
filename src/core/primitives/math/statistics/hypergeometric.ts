/**
 * The exact hypergeometric tail (bd tea-rags-mcp-gj45h). Silent coupling asks
 * how likely a file's imports reach one specific neighbour by chance: the
 * file's imports are draws without replacement from the corpus's import
 * endpoints, and the neighbour holds as many of those endpoints as it has
 * importers.
 */

import { logGamma } from "./log-gamma.js";

/** Below this many factors ln C(n, k) is summed directly — exact where log Γ differences of large n lose digits. */
const DIRECT_LOG_CHOOSE_MAX_FACTORS = 64;

/** ln C(n, k), 0 ≤ k ≤ n. */
function logChoose(n: number, k: number): number {
  const factors = Math.min(k, n - k);
  if (factors <= DIRECT_LOG_CHOOSE_MAX_FACTORS) {
    let sum = 0;
    for (let i = 1; i <= factors; i++) sum += Math.log((n - factors + i) / i);
    return sum;
  }
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * P(X ≥ k), X ~ Hypergeometric(population N, success states K, draws n): the
 * successes among n draws without replacement from N items, K of them
 * successes. Summed upward from the term at k in log space, relative to that
 * term — never as 1 − the lower tail, which cancels to 0 once the tail falls
 * below double precision. k at or below the forced minimum → 1, k above
 * min(K, n) → 0.
 */
export function hypergeometricUpperTail(
  successes: number,
  population: number,
  successStates: number,
  draws: number,
): number {
  const failureStates = population - successStates;
  if (successes <= Math.max(0, draws - failureStates)) return 1;
  const attainableMax = Math.min(successStates, draws);
  if (successes > attainableMax) return 0;
  const logTermAtK =
    logChoose(successStates, successes) + logChoose(failureStates, draws - successes) - logChoose(population, draws);
  let sum = 1;
  let term = 1;
  for (let x = successes; x < attainableMax; x++) {
    // term(x + 1) / term(x) = (K − x)(n − x) / ((x + 1)(N − K − n + x + 1))
    term *= ((successStates - x) * (draws - x)) / ((x + 1) * (failureStates - draws + x + 1));
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return Math.min(1, Math.exp(logTermAtK + Math.log(sum)));
}
