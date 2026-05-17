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
}

export function buildAccumulators(repoRoot: string, chunkMap: Map<string, ChunkLookupEntry[]>): AccumulatorInitResult {
  // Build relative path → entries lookup (chunkMap keys may be absolute paths).
  // Single-chunk files MUST go through the same pipeline as multi-chunk files —
  // skipping them used to leave `git.chunk = null` and break the system invariant
  // that every chunk has chunk-level data (recovery counts them as unenriched,
  // reranker has no overlay to read, etc.). The git work cost is per-COMMIT,
  // not per-chunk; processing single-chunk files adds no measurable overhead.
  const relativeChunkMap = new Map<string, ChunkLookupEntry[]>();
  for (const [filePath, entries] of chunkMap) {
    if (entries.length === 0) continue;
    const relPath = filePath.startsWith(repoRoot) ? filePath.slice(repoRoot.length + 1) : filePath;
    relativeChunkMap.set(relPath, entries);
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
        taskIds: new Set(),
      });
    }
  }

  return { relativeChunkMap, accumulators };
}
