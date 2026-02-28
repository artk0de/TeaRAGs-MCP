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

/**
 * Calculate the 95th percentile of a numeric array.
 * Returns 1 for empty arrays to avoid division by zero downstream.
 */
export function p95(arr: number[]): number {
  if (arr.length === 0) return 1;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] || 1;
}
