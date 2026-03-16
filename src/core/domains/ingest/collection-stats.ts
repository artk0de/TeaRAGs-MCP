/**
 * Generic collection-wide signal statistics computation.
 *
 * Receives already-fetched Qdrant points and PayloadSignalDescriptors,
 * computes statistics only for signals that declare a `stats` field.
 * Qdrant scrolling is handled at the API layer — this function is pure.
 */

import type { CollectionSignalStats, PayloadSignalDescriptor, SignalStats } from "../../contracts/types/trajectory.js";

/**
 * Read a value from a nested object using dot-notation path.
 * Returns undefined if any segment is missing.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  // Try flat key first (Qdrant stores dot-notation paths as flat keys)
  if (path in payload) return payload[path];
  // Fall back to nested traversal
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

  const languageCounts: Record<string, number> = {};
  const chunkTypeCounts: Record<string, number> = {};
  let docsCount = 0;
  let codeCount = 0;
  const distinctPaths = new Set<string>();
  const authorCounts = new Map<string, number>();

  for (const point of points) {
    for (const signal of statsSignals) {
      const val = readPayloadPath(point.payload, signal.key);
      if (typeof val === "number" && val > 0) {
        const arr = valueArrays.get(signal.key);
        if (arr) arr.push(val);
      }
    }

    const lang = point.payload["language"];
    if (typeof lang === "string") {
      languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;
    }

    const { chunkType } = point.payload as { chunkType?: unknown };
    if (typeof chunkType === "string") {
      chunkTypeCounts[chunkType] = (chunkTypeCounts[chunkType] ?? 0) + 1;
    }

    const isDoc = point.payload["isDocumentation"];
    if (isDoc === true) {
      docsCount++;
    } else {
      codeCount++;
    }

    const relPath = point.payload["relativePath"];
    if (typeof relPath === "string") {
      distinctPaths.add(relPath);
    }

    const author = point.payload["git.file.dominantAuthor"];
    if (typeof author === "string") {
      authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
    }
  }

  const perSignal = new Map<string, SignalStats>();
  for (const signal of statsSignals) {
    const values = valueArrays.get(signal.key);
    if (!values || values.length === 0) continue;
    values.sort((a, b) => a - b);

    const req = signal.stats;
    if (!req) continue;

    const result: SignalStats = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      percentiles: {},
    };

    if (req.labels && Object.keys(req.labels).length > 0) {
      for (const key of Object.keys(req.labels)) {
        const p = parseInt(key.slice(1), 10);
        if (!isNaN(p)) {
          result.percentiles[p] = percentile(values, p);
        }
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

  const sortedAuthors = Array.from(authorCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topAuthors = sortedAuthors.slice(0, 10).map(([name, chunks]) => ({ name, chunks }));
  const othersCount = sortedAuthors.slice(10).reduce((sum, [, chunks]) => sum + chunks, 0);

  return {
    perSignal,
    distributions: {
      totalFiles: distinctPaths.size,
      language: languageCounts,
      chunkType: chunkTypeCounts,
      documentation: { docs: docsCount, code: codeCount },
      topAuthors,
      othersCount,
    },
    computedAt: Date.now(),
  };
}
