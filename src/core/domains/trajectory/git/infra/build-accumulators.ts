/**
 * Phase 1 of buildChunkChurnMapUncached: initialize per-chunk accumulator state.
 *
 * Pure setup — converts absolute chunkMap keys to repo-relative paths and
 * allocates a fresh ChunkAccumulator per chunk entry.
 */

import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkAccumulator } from "./metrics.js";

export interface AccumulatorInitResult {
  /** Repo-relative path → chunk entries. Empty Map if no eligible files. */
  relativeChunkMap: Map<string, ChunkLookupEntry[]>;
  /** chunkId → zeroed accumulator. Empty Map if no eligible files. */
  accumulators: Map<string, ChunkAccumulator>;
  /** Files left out because their largest chunk `endLine` exceeds `maxFileLines`. */
  skippedLargeFiles: number;
}

/**
 * Build the relative path → entries lookup (chunkMap keys may be absolute
 * paths). Single-chunk files MUST go through the same pipeline as multi-chunk
 * files — skipping them used to leave `git.chunk = null` and break the system
 * invariant that every chunk has chunk-level data (recovery counts them as
 * unenriched, reranker has no overlay to read, etc.). The git work cost is
 * per-COMMIT, not per-chunk; processing single-chunk files adds no measurable
 * overhead. Exported for the off-thread churn-walk job builder
 * (bd tea-rags-mcp-iqpuu), which relativizes on the main side before shipping
 * the serializable job to the walk worker.
 */
export function relativizeChunkMap(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
): Map<string, ChunkLookupEntry[]> {
  const relativeChunkMap = new Map<string, ChunkLookupEntry[]>();
  for (const [filePath, entries] of chunkMap) {
    if (entries.length === 0) continue;
    const relPath = filePath.startsWith(repoRoot) ? filePath.slice(repoRoot.length + 1) : filePath;
    relativeChunkMap.set(relPath, entries);
  }
  return relativeChunkMap;
}

/**
 * A file past `maxFileLines` is dropped here, before discovery, so it gets NO
 * accumulator and therefore no overlay — never a zeroed one. The pipeline's
 * enrichment policy normally declines such a file first
 * (`GitEnrichmentProvider#shouldEnrich` → `git.chunk.skippedAs: "oversized"`),
 * so reaching this guard means a caller had no line count; an all-zero chunk
 * block would read as "no commit ever touched this method" (bd
 * tea-rags-mcp-2brzq).
 */
export function buildAccumulators(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  maxFileLines: number,
): AccumulatorInitResult {
  const relativeChunkMap = relativizeChunkMap(repoRoot, chunkMap);
  let skippedLargeFiles = 0;
  for (const [relPath, entries] of relativeChunkMap) {
    const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
    if (maxLine > maxFileLines) {
      relativeChunkMap.delete(relPath);
      skippedLargeFiles++;
    }
  }

  // Per-chunk accumulators
  const accumulators = new Map<string, ChunkAccumulator>();

  for (const [, entries] of relativeChunkMap) {
    for (const entry of entries) {
      accumulators.set(entry.chunkId, {
        commitShas: new Set(),
        authors: new Set(),
        bugFixCount: 0,
        lastModifiedAt: 0,
        linesAdded: 0,
        linesDeleted: 0,
        commitTimestamps: [],
        commitAuthors: [],
        commitIsFix: [],
        taskIds: new Set(),
      });
    }
  }

  return { relativeChunkMap, accumulators, skippedLargeFiles };
}
