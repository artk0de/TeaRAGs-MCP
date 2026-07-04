/**
 * Chunk-level churn analysis from git history.
 * Uses CLI for commit discovery and `git cat-file --batch` for blob reads;
 * parent oids come from `CommitInfo.parents` (bd tea-rags-mcp-iqpuu).
 */

import type { CatFileBatchReader } from "../../../../adapters/git/client.js";
import type { BlameLine, FileChurnData } from "../../../../adapters/git/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay } from "../types.js";
import { assembleOverlays } from "./assemble-overlays.js";
import { buildAccumulators } from "./build-accumulators.js";
import type { GitEnrichmentCache } from "./cache.js";
import type { SquashOptions } from "./metrics.js";
import {
  walkCommits,
  type ChunkChurnWalkStats,
  type ChunkConcurrencySemaphore,
  type WalkCommitDiffMemo,
  type WalkCommitDiscovery,
} from "./walk-commits.js";

export type {
  ChunkChurnWalkStats,
  ChunkConcurrencySemaphore,
  WalkCommitDiffMemo,
  WalkCommitDiscovery,
} from "./walk-commits.js";

const MAX_FILE_LINES_DEFAULT = 10000;

/**
 * Build chunk-level churn overlays by mapping git hunks to chunk line ranges.
 *
 * Algorithm:
 * 1. Get commits within `maxAgeMonths` window via CLI pathspec filtering
 * 2. For each commit: parents[0] → parent OID, blob read × 2 → structuredPatch → hunks
 * 3. Map each hunk to overlapping chunks and accumulate per-chunk stats
 *
 * @returns Map<relativePath, Map<chunkId, ChunkChurnOverlay>>
 */
export async function buildChunkChurnMap(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  enrichmentCache: GitEnrichmentCache,
  isoGitCache: Record<string, unknown>,
  concurrency = 10,
  maxAgeMonths = 6,
  fileChurnDataMap?: Map<string, FileChurnData>,
  squashOpts?: SquashOptions,
  chunkTimeoutMs = 120000,
  maxFileLines = MAX_FILE_LINES_DEFAULT,
  externalSemaphore?: ChunkConcurrencySemaphore,
  skipCache = false,
  blameByPath?: Map<string, BlameLine[]>,
  blobReader?: CatFileBatchReader,
  diffMemo?: WalkCommitDiffMemo,
  commitDiscovery?: WalkCommitDiscovery,
  onWalkStats?: (stats: ChunkChurnWalkStats) => void,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  if (!skipCache) {
    const cached = await enrichmentCache.getChunkChurn(repoRoot);
    if (cached) return cached;
  }

  const result = await buildChunkChurnMapUncached(
    repoRoot,
    chunkMap,
    isoGitCache,
    concurrency,
    maxAgeMonths,
    fileChurnDataMap,
    squashOpts,
    chunkTimeoutMs,
    maxFileLines,
    externalSemaphore,
    blameByPath,
    blobReader,
    diffMemo,
    commitDiscovery,
    onWalkStats,
  );

  if (!skipCache) {
    await enrichmentCache.setChunkChurn(repoRoot, result);
  }

  return result;
}

export async function buildChunkChurnMapUncached(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  isoGitCache: Record<string, unknown>,
  concurrency: number,
  maxAgeMonths: number,
  fileChurnDataMap?: Map<string, FileChurnData>,
  squashOpts?: SquashOptions,
  chunkTimeoutMs = 120000,
  maxFileLines = MAX_FILE_LINES_DEFAULT,
  externalSemaphore?: ChunkConcurrencySemaphore,
  blameByPath?: Map<string, BlameLine[]>,
  blobReader?: CatFileBatchReader,
  diffMemo?: WalkCommitDiffMemo,
  commitDiscovery?: WalkCommitDiscovery,
  onWalkStats?: (stats: ChunkChurnWalkStats) => void,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  // Phase 1: initialize per-chunk accumulator state
  const { relativeChunkMap, accumulators } = buildAccumulators(repoRoot, chunkMap);

  if (relativeChunkMap.size === 0) {
    // No walk happened — the per-walk instrumentation callback is NOT invoked.
    return new Map();
  }

  const t0 = Date.now();

  // Phase 2: walk commits, parallel blob reads + structuredPatch,
  // offset-aware hunk → chunk mapping (mutates accumulators in place)
  const { commitCount, holdCount, semWaitMs, blobReads, patchCalls, memoHits } = await walkCommits({
    repoRoot,
    relativeChunkMap,
    accumulators,
    isoGitCache,
    concurrency,
    maxAgeMonths,
    chunkTimeoutMs,
    maxFileLines,
    externalSemaphore,
    squashOpts,
    fileChurnDataMap,
    blobReader,
    diffMemo,
    commitDiscovery,
  });

  // Phase 3: assemble per-file overlay maps
  const result = assembleOverlays({
    relativeChunkMap,
    accumulators,
    fileChurnDataMap,
    squashOpts,
    blameByPath,
  });

  // bd tea-rags-mcp-iqpuu: ONE instrumentation snapshot per walk — wall time
  // covers the whole uncached build (discovery slice → walk → assembly).
  const wallMs = Date.now() - t0;
  onWalkStats?.({
    files: relativeChunkMap.size,
    commits: commitCount,
    holdCount,
    semWaitMs,
    blobReads,
    patches: patchCalls,
    memoHits,
    wallMs,
  });

  if (isDebug()) {
    const totalMs = Date.now() - t0;
    const filesWithOverlays = result.size;
    const totalOverlays = Array.from(result.values()).reduce((sum, m) => sum + m.size, 0);
    console.error(
      `[ChunkChurn] Total: ${totalMs}ms | ${commitCount} commits → ` +
        `${totalOverlays} overlays across ${filesWithOverlays} files`,
    );
  }

  return result;
}
