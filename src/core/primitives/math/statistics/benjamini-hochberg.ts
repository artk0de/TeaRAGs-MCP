/**
 * Benjamini–Hochberg multiplicity control (bd tea-rags-mcp-xb669.8), lifted
 * from the co-change pair gate so the dependency norms test their role-pair
 * family at the same false-discovery rate.
 */

/** The false-discovery rate BH controls — the conventional 5% FDR. */
export const CONVENTIONAL_FDR_Q = 0.05;

/**
 * Benjamini–Hochberg: the largest k with p_(k) ≤ q·k/m, 0 when none. The
 * p-values are the family's TESTED members ascending; the rest of the family
 * (p = 1) still counts in `familySize`.
 */
export function benjaminiHochbergRejectionCount(
  ascendingPValues: readonly number[],
  familySize: number,
  q: number = CONVENTIONAL_FDR_Q,
): number {
  if (familySize <= 0) return 0;
  let rejected = 0;
  for (let rank = 1; rank <= ascendingPValues.length; rank++) {
    if (ascendingPValues[rank - 1] <= (q * rank) / familySize) rejected = rank;
  }
  return rejected;
}
