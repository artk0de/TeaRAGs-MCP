/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import type { ChunkLookupEntry } from "../../../../types.js";
import type { FileChurnData } from "../../git/types.js";
import type { EnrichmentProvider } from "../types.js";
import { GitEnrichmentCache } from "./cache.js";
import { buildChunkChurnMap } from "./chunk-reader.js";
import { buildFileMetadataForPaths, buildFileMetadataMap } from "./file-reader.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";

  private readonly enrichmentCache = new GitEnrichmentCache();
  private readonly isoGitCache: Record<string, unknown> = {};
  private lastFileResult: Map<string, FileChurnData> | null = null;

  async buildFileMetadata(root: string, options?: { paths?: string[] }): Promise<Map<string, Record<string, unknown>>> {
    let rawData: Map<string, FileChurnData>;

    if (options?.paths) {
      rawData = await buildFileMetadataForPaths(root, options.paths);
    } else {
      rawData = await buildFileMetadataMap(root, this.enrichmentCache);
    }

    this.lastFileResult = rawData;

    // Return raw FileChurnData — coordinator/applier will call computeFileMetadata
    // with actual line count when applying per-file
    const result = new Map<string, Record<string, unknown>>();
    for (const [path, churnData] of rawData) {
      result.set(path, churnData as unknown as Record<string, unknown>);
    }
    return result;
  }

  async buildChunkMetadata(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, Record<string, unknown>>>> {
    const concurrency = parseInt(process.env.GIT_CHUNK_CONCURRENCY ?? "10", 10);
    const maxAgeMonths = parseFloat(process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6");

    const rawResult = await buildChunkChurnMap(
      root,
      chunkMap,
      this.enrichmentCache,
      this.isoGitCache,
      concurrency,
      maxAgeMonths,
      this.lastFileResult ?? undefined,
    );

    const result = new Map<string, Map<string, Record<string, unknown>>>();
    for (const [filePath, overlayMap] of rawResult) {
      const chunkEntries = new Map<string, Record<string, unknown>>();
      for (const [chunkId, overlay] of overlayMap) {
        chunkEntries.set(chunkId, overlay as unknown as Record<string, unknown>);
      }
      result.set(filePath, chunkEntries);
    }
    return result;
  }
}
