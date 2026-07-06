/**
 * HEAD-based cache for git enrichment results.
 * Invalidates automatically when HEAD changes.
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { FileChurnData } from "../../../../adapters/vcs/types.js";
import type { ChunkChurnOverlay } from "../types.js";

export class GitEnrichmentCache {
  private readonly fileMetadataCache = new Map<string, { headSha: string; data: Map<string, FileChurnData> }>();
  private readonly chunkChurnCache = new Map<
    string,
    { headSha: string; data: Map<string, Map<string, ChunkChurnOverlay>> }
  >();

  async getFileMetadata(cacheKey: string, adapter: VcsGitAdapter): Promise<Map<string, FileChurnData> | null> {
    try {
      const headSha = await adapter.getHead();
      const cached = this.fileMetadataCache.get(cacheKey);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Not a git repo or HEAD unresolvable — skip cache
    }
    return null;
  }

  async setFileMetadata(cacheKey: string, adapter: VcsGitAdapter, data: Map<string, FileChurnData>): Promise<void> {
    try {
      const headSha = await adapter.getHead();
      this.fileMetadataCache.set(cacheKey, { headSha, data });
    } catch {
      // Non-fatal
    }
  }

  async getChunkChurn(adapter: VcsGitAdapter): Promise<Map<string, Map<string, ChunkChurnOverlay>> | null> {
    try {
      const headSha = await adapter.getHead();
      const cached = this.chunkChurnCache.get(adapter.repoRoot);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Skip cache
    }
    return null;
  }

  async setChunkChurn(adapter: VcsGitAdapter, data: Map<string, Map<string, ChunkChurnOverlay>>): Promise<void> {
    try {
      const headSha = await adapter.getHead();
      this.chunkChurnCache.set(adapter.repoRoot, { headSha, data });
    } catch {
      // Non-fatal
    }
  }
}
