/**
 * Generic collection-wide signal statistics computation.
 *
 * Receives already-fetched Qdrant points and PayloadSignalDescriptors,
 * computes percentile distributions for all numeric signals.
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
 * Compute collection-wide percentile stats for all numeric PayloadSignalDescriptors.
 *
 * - Filters to `type: "number"` signals only (skips string, boolean, etc.)
 * - Resolves dot-notation paths against each point's payload
 * - Skips missing/non-numeric/zero-or-negative values
 * - Returns empty perSignal map for signals with no valid values
 */
export function computeCollectionStats(
  points: { payload: Record<string, unknown> }[],
  signals: PayloadSignalDescriptor[],
): CollectionSignalStats {
  const numericSignals = signals.filter((s) => s.type === "number");
  const valueArrays = new Map<string, number[]>();

  for (const signal of numericSignals) {
    valueArrays.set(signal.key, []);
  }

  for (const point of points) {
    for (const signal of numericSignals) {
      const val = readPayloadPath(point.payload, signal.key);
      if (typeof val === "number" && val > 0) {
        valueArrays.get(signal.key)!.push(val);
      }
    }
  }

  const perSignal = new Map<string, SignalStats>();
  for (const [key, values] of valueArrays) {
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    perSignal.set(key, {
      p25: percentile(values, 25),
      p50: percentile(values, 50),
      p75: percentile(values, 75),
      p95: percentile(values, 95),
      count: values.length,
    });
  }

  return { perSignal, computedAt: Date.now() };
}
