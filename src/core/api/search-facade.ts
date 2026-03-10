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
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { Reranker } from "../search/reranker.js";
import { SearchModule } from "../search/search-module.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type { CodeSearchResult, SearchCodeConfig, SearchOptions } from "../types.js";
import type { StatsCache } from "./stats-cache.js";

export class SearchFacade {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: SearchCodeConfig,
    private readonly reranker: Reranker,
    private readonly registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
  ) {}

  /** Search code semantically */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    if (this.statsCache && !this.reranker.hasCollectionStats) {
      await this.loadStatsFromCache(collectionName);
    }

    // Create filterBuilder closure from registry
    const { registry } = this;
    const filterBuilder = registry
      ? (params: Record<string, unknown>, level?: string) =>
          registry.buildFilter(params, (level as "chunk" | "file") ?? "chunk") as Record<string, unknown> | undefined
      : undefined;

    const search = new SearchModule(
      this.qdrant,
      this.embeddings,
      this.config,
      this.reranker,
      collectionName,
      filterBuilder,
    );

    return search.searchCode(query, options);
  }

  /** Load cached collection stats into reranker (cold start). */
  private async loadStatsFromCache(collectionName: string): Promise<void> {
    try {
      const stats = this.statsCache?.load(collectionName);
      if (stats) {
        this.reranker.setCollectionStats(stats);
      }
    } catch {
      // Stats loading failure should not prevent search
    }
  }
}
