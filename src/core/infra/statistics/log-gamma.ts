/**
 * log Γ — the one special function the foundation statistics share (bd
 * tea-rags-mcp-xb669.8): the Poisson tails and the exact binomial tail both
 * resolve their far terms in log space through it.
 */

/** Lanczos (g = 7, n = 9) log Γ(x), x > 0. */
export function logGamma(x: number): number {
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
