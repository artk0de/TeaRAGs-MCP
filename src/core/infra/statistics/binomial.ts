/**
 * The exact binomial tail and the two-sided sign test built on it (bd
 * tea-rags-mcp-xb669.8). The dependency norms judge whether a role pair has
 * an established DIRECTION: n(A→B) against n(B→A), each edge a fair coin
 * under the null.
 */

import { logGamma } from "./log-gamma.js";

/**
 * P(X ≤ k), X ~ Binomial(n, p), 0 < p < 1. Summed downward from the term at k
 * in log space, relative to that term, so a far tail (k far below n·p) is
 * resolved rather than rounded to 0.
 */
export function binomialLowerTail(successes: number, trials: number, probability: number): number {
  if (successes < 0) return 0;
  if (successes >= trials) return 1;
  const logTermAtK =
    logGamma(trials + 1) -
    logGamma(successes + 1) -
    logGamma(trials - successes + 1) +
    successes * Math.log(probability) +
    (trials - successes) * Math.log1p(-probability);
  const oddsDown = (1 - probability) / probability;
  let sum = 1;
  let term = 1;
  for (let i = successes; i > 0; i--) {
    // term(i − 1) / term(i) = i / (n − i + 1) · (1 − p) / p
    term *= (i / (trials - i + 1)) * oddsDown;
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return Math.min(1, Math.exp(logTermAtK + Math.log(sum)));
}

/**
 * P(X ≥ k), X ~ Binomial(n, p). Summed upward from the term at k in log space
 * (via {@link logGamma}), relative to that term — never as
 * 1 − {@link binomialLowerTail}, which cancels to 0 once the tail falls below
 * double precision (p ~ 1e-10 and smaller).
 */
export function binomialUpperTail(successes: number, trials: number, probability: number): number {
  if (successes <= 0) return 1;
  if (successes > trials || probability <= 0) return 0;
  if (probability >= 1) return 1;
  const logTermAtK =
    logGamma(trials + 1) -
    logGamma(successes + 1) -
    logGamma(trials - successes + 1) +
    successes * Math.log(probability) +
    (trials - successes) * Math.log1p(-probability);
  const oddsUp = probability / (1 - probability);
  let sum = 1;
  let term = 1;
  for (let i = successes; i < trials; i++) {
    // term(i + 1) / term(i) = (n − i) / (i + 1) · p / (1 − p)
    term *= ((trials - i) / (i + 1)) * oddsUp;
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return Math.min(1, Math.exp(logTermAtK + Math.log(sum)));
}

/**
 * The exact two-sided sign test of `a` against `b` at p = ½: twice the
 * minority's lower tail, capped at 1 — the null is symmetric, so which side is
 * the minority is read off the counts. An empty pair carries no evidence (1).
 */
export function signTestPValue(a: number, b: number): number {
  const trials = a + b;
  if (trials === 0) return 1;
  return Math.min(1, 2 * binomialLowerTail(Math.min(a, b), trials, 0.5));
}
