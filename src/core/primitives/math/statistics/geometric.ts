/**
 * The geometric upper tail (bd tea-rags-mcp-r8hme.52.17): the null the
 * composition-table flag tests a file's excess fan-out against — a population
 * concentrated at its minimum with a decaying tail, whose single parameter the
 * population's own mean fits (the MLE).
 */

/**
 * P(X ≥ k), X ~ Geometric on {0, 1, …} with mean μ: (μ / (1 + μ))^k. Resolved
 * in log space so a far tail stays a positive number. μ = 0 is the point mass
 * at 0.
 */
export function geometricUpperTail(support: number, mean: number): number {
  if (support <= 0) return 1;
  if (!(mean > 0)) return 0;
  return Math.exp(support * Math.log(mean / (1 + mean)));
}
