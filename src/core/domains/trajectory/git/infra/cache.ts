/**
 * HEAD-based cache for git enrichment results.
 * Invalidates automatically when HEAD changes.
 */

import { getHead } from "../../../../adapters/git/client.js";
import type { FileChurnData } from "../../../../adapters/git/types.js";
import type { ChunkChurnOverlay } from "../types.js";

export class GitEnrichmentCache {
  private readonly fileMetadataCache = new Map<string, { headSha: string; data: Map<string, FileChurnData> }>();
  private readonly chunkChurnCache = new Map<
    string,
    { headSha: string; data: Map<string, Map<string, ChunkChurnOverlay>> }
  >();

  async getFileMetadata(cacheKey: string, repoRoot: string): Promise<Map<string, FileChurnData> | null> {
    try {
      const headSha = await getHead(repoRoot);
      const cached = this.fileMetadataCache.get(cacheKey);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Not a git repo or HEAD unresolvable — skip cache
    }
    return null;
  }

  async setFileMetadata(cacheKey: string, repoRoot: string, data: Map<string, FileChurnData>): Promise<void> {
    try {
      const headSha = await getHead(repoRoot);
      this.fileMetadataCache.set(cacheKey, { headSha, data });
    } catch {
      // Non-fatal
    }
  }

  async getChunkChurn(repoRoot: string): Promise<Map<string, Map<string, ChunkChurnOverlay>> | null> {
    try {
      const headSha = await getHead(repoRoot);
      const cached = this.chunkChurnCache.get(repoRoot);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Skip cache
    }
    return null;
  }

  async setChunkChurn(repoRoot: string, data: Map<string, Map<string, ChunkChurnOverlay>>): Promise<void> {
    try {
      const headSha = await getHead(repoRoot);
      this.chunkChurnCache.set(repoRoot, { headSha, data });
    } catch {
      // Non-fatal
    }
  }
}
