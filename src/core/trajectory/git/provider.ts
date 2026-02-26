/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveRepoRoot } from "../../adapters/git/client.js";
import type { FileChurnData } from "../../adapters/git/types.js";
import type { FileTransform } from "../../ingest/pipeline/enrichment/applier.js";
import type { EnrichmentProvider } from "../../ingest/pipeline/enrichment/types.js";
import type { ChunkLookupEntry } from "../../types.js";
import { GitEnrichmentCache } from "./infra/cache.js";
import { buildChunkChurnMap } from "./infra/chunk-reader.js";
import { buildFileMetadataForPaths, buildFileMetadataMap } from "./infra/file-reader.js";
import { computeFileMetadata } from "./infra/metrics.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";

  resolveRoot(absolutePath: string): string {
    return resolveRepoRoot(absolutePath);
  }

  readonly fileTransform: FileTransform = (data, maxEndLine) =>
    computeFileMetadata(data as unknown as FileChurnData, maxEndLine) as unknown as Record<string, unknown>;

  private readonly enrichmentCache = new GitEnrichmentCache();
  private readonly isoGitCache: Record<string, unknown> = {};
  private lastFileResult: Map<string, FileChurnData> | null = null;

  async buildFileMetadata(root: string, options?: { paths?: string[] }): Promise<Map<string, Record<string, unknown>>> {
    // Fast check: skip if not a git repo
    if (!existsSync(join(root, ".git"))) {
      return new Map();
    }

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
