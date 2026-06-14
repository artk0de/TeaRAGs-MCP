/**
 * Generic signal utility functions.
 *
 * Pure math — no payload access, no provider knowledge.
 * Provider-specific payload accessors live in trajectory/<provider>/rerank/derived-signals/helpers.ts.
 */

// ---------------------------------------------------------------------------
// Normalization & percentiles
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Alpha-blending (file ↔ chunk)
// ---------------------------------------------------------------------------

/** Default minimum chunk commits for full maturity in alpha computation. */
export const DEFAULT_CHUNK_MATURITY_THRESHOLD = 3;

/**
 * Compute alpha blending factor for chunk-vs-file data quality.
 * alpha = coverageRatio × maturity, clamped to [0, 1].
 *   coverageRatio = chunkCount / fileCount
 *   maturity = min(1, chunkCount / maturityThreshold)
 *
 * Maturity prevents low-commit chunks (1-2 commits) from overriding
 * reliable file-level statistics.
 */
export function computeAlpha(
  chunkCount: number | undefined,
  fileCount: number | undefined,
  maturityThreshold = DEFAULT_CHUNK_MATURITY_THRESHOLD,
): number {
  if (chunkCount === undefined || chunkCount <= 0) return 0;
  if (fileCount === undefined || fileCount <= 0) return 0;
  const coverageRatio = chunkCount / fileCount;
  const maturity = Math.min(1, chunkCount / maturityThreshold);
  return Math.min(1, coverageRatio * maturity);
}

/**
 * Blend chunk and file signal values using alpha.
 * When chunkValue is undefined, falls back to fileValue.
 */
export function blend(chunkValue: number | undefined, fileValue: number, alpha: number): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}

// ---------------------------------------------------------------------------
// Confidence dampening
// ---------------------------------------------------------------------------

/**
 * Quadratic confidence dampening.
 * Returns 1 when sampleCount >= threshold, otherwise (n/k)^power.
 * Used to dampen statistical signals that are unreliable with small samples.
 */
export function confidenceDampening(sampleCount: number, threshold: number, power = 2): number {
  if (threshold <= 0) return 1;
  if (sampleCount >= threshold) return 1;
  return Math.pow(sampleCount / threshold, power);
}

// ---------------------------------------------------------------------------
// Payload value resolution
// ---------------------------------------------------------------------------

/** Logical codegraph descriptor key → physical nested-symbols path. */
const CODEGRAPH_PATH_RE = /^codegraph\.(file|chunk)\.(.+)$/;

/**
 * Resolve a dot-notation payload path to its value — the single source of truth
 * for payload addressing across the reranker score/overlay paths and the
 * collection-stats accumulator.
 *
 * Resolution order:
 *  1. Flat key — Qdrant stores dotted paths as flat keys (`payload["git.file.x"]`).
 *  2. Codegraph nested-symbols form — the logical descriptor key
 *     `codegraph.{file|chunk}.X` maps to the physical
 *     `payload.codegraph.symbols.{file|chunk}.X` (EnrichmentApplier writes
 *     codegraph signals under the `codegraph.symbols` provider key with bare
 *     inner keys).
 *  3. Plain nested traversal — `payload.git.file.x` and any other dotted shape,
 *     so test fixtures feeding alternate shapes still resolve.
 */
export function resolvePayloadValue(payload: Record<string, unknown>, path: string): unknown {
  if (path in payload) return payload[path];

  const cg = CODEGRAPH_PATH_RE.exec(path);
  if (cg) {
    const { codegraph } = payload as { codegraph?: unknown };
    if (codegraph && typeof codegraph === "object") {
      const { symbols } = codegraph as { symbols?: unknown };
      if (symbols && typeof symbols === "object") {
        const scoped = (symbols as Record<string, unknown>)[cg[1]];
        const bareKey = cg[2];
        if (scoped && typeof scoped === "object" && bareKey in (scoped as Record<string, unknown>)) {
          return (scoped as Record<string, unknown>)[bareKey];
        }
      }
    }
  }

  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
