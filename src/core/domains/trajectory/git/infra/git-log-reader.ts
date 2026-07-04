/**
 * GitLogReader — stateful facade over git enrichment modules.
 *
 * Holds cache state (HEAD-based result cache + isomorphic-git pack cache)
 * and delegates to file-reader, chunk-reader, and metrics modules. History
 * access rides the per-call `VcsGitAdapter` (mirrors how the class used to
 * receive repoRoot per method).
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { FileChurnData } from "../../../../adapters/vcs/types.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay } from "../types.js";
import { GitEnrichmentCache } from "./cache.js";
import { buildChunkChurnMap as buildChunkChurnMapImpl } from "./chunk-reader.js";
import { buildFileSignalMap as buildFileSignalMapImpl, buildFileSignalsForPaths } from "./file-reader.js";
import { computeChunkSignals, computeFileSignals, overlaps, type ChunkAccumulator } from "./metrics.js";
import { extractTaskIds } from "./utils.js";

// Re-exports from canonical locations (backward compat for test consumers)
export { type ChunkAccumulator, computeChunkSignals, computeFileSignals, extractTaskIds, overlaps };

export class GitLogReader {
  // isomorphic-git pack file cache — used only for individual object reads
  // (readBlob, readCommit) in chunk-churn analysis
  private readonly cache: Record<string, unknown> = {};

  // HEAD-based result cache — invalidated when HEAD changes
  private readonly enrichmentCache = new GitEnrichmentCache();

  /**
   * Build per-file FileChurnData from git history.
   * Delegates to file-reader (adapter-backed).
   */
  async buildFileSignalMap(
    adapter: VcsGitAdapter,
    maxAgeMonths?: number,
    timeoutMs?: number,
  ): Promise<Map<string, FileChurnData>> {
    return buildFileSignalMapImpl(adapter, this.enrichmentCache, maxAgeMonths, timeoutMs);
  }

  /** @deprecated Use VcsGitAdapter#getHead directly */
  async getHead(adapter: VcsGitAdapter): Promise<string> {
    return adapter.getHead();
  }

  /**
   * Fetch file-level metadata for specific files (no --since filter).
   * Delegates to file-reader.
   */
  async buildFileSignalsForPaths(
    adapter: VcsGitAdapter,
    paths: string[],
    timeoutMs = 30000,
  ): Promise<Map<string, FileChurnData>> {
    return buildFileSignalsForPaths(adapter, paths, timeoutMs);
  }

  /**
   * Build chunk-level churn overlays.
   * Delegates to chunk-reader.
   */
  async buildChunkChurnMap(
    adapter: VcsGitAdapter,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    concurrency = 10,
    maxAgeMonths = 6,
    fileChurnDataMap?: Map<string, FileChurnData>,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    return buildChunkChurnMapImpl(
      adapter,
      chunkMap,
      this.enrichmentCache,
      this.cache,
      concurrency,
      maxAgeMonths,
      fileChurnDataMap,
    );
  }
}
