/**
 * Generic signal utility functions.
 *
 * Git-specific payload accessors live in trajectory/git/infra/signal-utils.ts.
 */

/**
 * Normalize a value to 0-1 range, clamped.
 */
export function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}
