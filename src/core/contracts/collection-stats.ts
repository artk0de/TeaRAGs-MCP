/**
 * Generic collection-wide signal statistics computation.
 *
 * Receives already-fetched Qdrant points and PayloadSignalDescriptors,
 * computes statistics only for signals that declare a `stats` field.
 * Qdrant scrolling is handled at the API layer — this function is pure.
 */

import type { CollectionSignalStats, PayloadSignalDescriptor, SignalStats } from "./types/trajectory.js";

/**
 * Read a value from a nested object using dot-notation path.
 * Returns undefined if any segment is missing.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Compute percentile from a sorted array using linear interpolation.
 *
 * For p in [0, 100], computes the index as (p/100) * (n-1),
 * then interpolates between the two adjacent values.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/**
 * Compute collection-wide stats for PayloadSignalDescriptors that declare a `stats` field.
 *
 * - Filters to signals WITH `stats` request (not just numeric type)
 * - Resolves dot-notation paths against each point's payload
 * - Skips missing/non-numeric/zero-or-negative values
 * - Computes only what's declared: percentiles, mean, stddev
 * - Returns empty perSignal map for signals with no valid values
 */
export function computeCollectionStats(
  points: { payload: Record<string, unknown> }[],
  signals: PayloadSignalDescriptor[],
): CollectionSignalStats {
  const statsSignals = signals.filter((s) => s.stats !== undefined);
  const valueArrays = new Map<string, number[]>();

  for (const signal of statsSignals) {
    valueArrays.set(signal.key, []);
  }

  for (const point of points) {
    for (const signal of statsSignals) {
      const val = readPayloadPath(point.payload, signal.key);
      if (typeof val === "number" && val > 0) {
        valueArrays.get(signal.key)!.push(val);
      }
    }
  }

  const perSignal = new Map<string, SignalStats>();
  for (const signal of statsSignals) {
    const values = valueArrays.get(signal.key)!;
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);

    const result: SignalStats = { count: values.length };
    const req = signal.stats!;

    if (req.percentiles && req.percentiles.length > 0) {
      result.percentiles = {};
      for (const p of req.percentiles) {
        result.percentiles[p] = percentile(values, p);
      }
    }

    if (req.mean) {
      const sum = values.reduce((a, b) => a + b, 0);
      result.mean = sum / values.length;
    }

    if (req.stddev) {
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
      result.stddev = Math.sqrt(variance);
    }

    perSignal.set(signal.key, result);
  }

  return { perSignal, computedAt: Date.now() };
}
