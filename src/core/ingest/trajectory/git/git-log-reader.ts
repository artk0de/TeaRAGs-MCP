/**
 * GitLogReader — reads git history via CLI `git log` (primary)
 * with isomorphic-git fallback.
 *
 * Builds per-file FileChurnData from git log in a single pass.
 * Falls back to isomorphic-git if CLI git log fails or times out.
 */

import { getHead } from "../../../adapters/git/client.js";
import type { ChunkLookupEntry } from "../../../types.js";
import { GitEnrichmentCache } from "../enrichment/git/cache.js";
import { buildChunkChurnMap as buildChunkChurnMapImpl } from "../enrichment/git/chunk-reader.js";
import {
  buildFileMetadataForPaths,
  buildFileMetadataMap as buildFileMetadataMapImpl,
} from "../enrichment/git/file-reader.js";
import {
  computeChunkOverlay,
  computeFileMetadata,
  overlaps,
  type ChunkAccumulator,
} from "../enrichment/git/metrics.js";
import { extractTaskIds } from "../enrichment/utils.js";
import type { ChunkChurnOverlay, FileChurnData } from "./types.js";

// Re-exports from canonical locations (backward compat for consumers)
export { type ChunkAccumulator, computeChunkOverlay, computeFileMetadata, extractTaskIds, overlaps };

export class GitLogReader {
  // isomorphic-git pack file cache (shared across calls for performance)
  private readonly cache: Record<string, unknown> = {};

  // HEAD-based result cache — invalidated when HEAD changes
  private readonly enrichmentCache = new GitEnrichmentCache();

  /**
   * Build per-file FileChurnData from git history.
   * Delegates to enrichment/git/file-reader.
   */
  async buildFileMetadataMap(repoRoot: string, maxAgeMonths?: number): Promise<Map<string, FileChurnData>> {
    return buildFileMetadataMapImpl(repoRoot, this.enrichmentCache, this.cache, maxAgeMonths);
  }

  /** @deprecated Use getHead from adapters/git/client.js */
  async getHead(repoRoot: string): Promise<string> {
    return getHead(repoRoot);
  }

  /**
   * Fetch file-level metadata for specific files (no --since filter).
   * Delegates to enrichment/git/file-reader.
   */
  async buildFileMetadataForPaths(
    repoRoot: string,
    paths: string[],
    timeoutMs = 30000,
  ): Promise<Map<string, FileChurnData>> {
    return buildFileMetadataForPaths(repoRoot, paths, timeoutMs);
  }

  /**
   * Build chunk-level churn overlays.
   * Delegates to enrichment/git/chunk-reader.
   */
  async buildChunkChurnMap(
    repoRoot: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    concurrency = 10,
    maxAgeMonths = 6,
    fileChurnDataMap?: Map<string, FileChurnData>,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    return buildChunkChurnMapImpl(
      repoRoot,
      chunkMap,
      this.enrichmentCache,
      this.cache,
      concurrency,
      maxAgeMonths,
      fileChurnDataMap,
    );
  }
}
