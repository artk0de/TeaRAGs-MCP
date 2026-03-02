/**
 * SearchFacade - Public API for semantic code search.
 *
 * Delegates to:
 * - SearchModule: semantic code search over indexed collections
 *
 * Cold-start: loads cached collection stats into reranker on first search.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../contracts/collection.js";
import type { Reranker } from "../search/reranker.js";
import { SearchModule } from "../search/search-module.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type { CodeConfig, CodeSearchResult, SearchOptions } from "../types.js";
import type { StatsCache } from "./stats-cache.js";

export class SearchFacade {
  private readonly search: SearchModule;

  constructor(
    qdrant: QdrantManager,
    embeddings: EmbeddingProvider,
    config: CodeConfig,
    private readonly reranker: Reranker,
    registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
  ) {
    this.search = new SearchModule(qdrant, embeddings, config, reranker, registry);
  }

  /** Search code semantically */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    if (this.statsCache && !this.reranker.hasCollectionStats) {
      await this.loadStatsFromCache(path);
    }
    return this.search.searchCode(path, query, options);
  }

  /** Load cached collection stats into reranker (cold start). */
  private async loadStatsFromCache(path: string): Promise<void> {
    try {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      const stats = this.statsCache?.load(collectionName);
      if (stats) {
        this.reranker.setCollectionStats(stats);
      }
    } catch {
      // Stats loading failure should not prevent search
    }
  }
}
