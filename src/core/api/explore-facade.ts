/**
 * ExploreFacade — thin orchestrator for code exploration and search.
 *
 * Facade responsibilities (KEPT here):
 *   resolveCollection, validateCollectionExists, ensureStats, embed query, checkDrift
 *
 * Business logic (DELEGATED to strategies):
 *   fetchLimit, postProcess, metaOnly, BM25 generation, scroll+rank, excludeDocumentation
 *
 * Cold-start: loads cached collection stats into reranker on first search.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import { ExploreModule } from "../explore/explore-module.js";
import type { Reranker } from "../explore/reranker.js";
import {
  createExploreStrategy,
  type BaseExploreStrategy,
  type ExploreContext,
  type ExploreResult,
} from "../explore/strategies/index.js";
import type { SchemaDriftMonitor } from "../infra/schema-drift-monitor.js";
import type { StatsCache } from "../infra/stats-cache.js";
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type { CodeSearchResult, ExploreCodeConfig, SearchOptions } from "../types.js";
import type {
  HybridSearchRequest,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchCodeResult,
  SearchResponse,
  SearchResult,
  SemanticSearchRequest,
} from "./app.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class CollectionRefError extends Error {
  constructor() {
    super("Either 'collection' or 'path' parameter is required.");
    this.name = "CollectionRefError";
  }
}

class CollectionNotFoundError extends Error {
  constructor(collectionName: string, path?: string) {
    super(`Collection "${collectionName}" does not exist.${path ? ` Codebase at "${path}" may not be indexed.` : ""}`);
    this.name = "CollectionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// ExploreFacade
// ---------------------------------------------------------------------------

export class ExploreFacade {
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: ExploreCodeConfig,
    private readonly reranker: Reranker,
    private readonly registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
    payloadSignals?: PayloadSignalDescriptor[],
    essentialKeys?: string[],
    private readonly schemaDriftMonitor?: SchemaDriftMonitor,
  ) {
    const signals = payloadSignals ?? [];
    const keys = essentialKeys ?? [];
    this.vectorStrategy = createExploreStrategy("vector", qdrant, reranker, signals, keys);
    this.hybridStrategy = createExploreStrategy("hybrid", qdrant, reranker, signals, keys);
    this.scrollRankStrategy = createExploreStrategy("scroll-rank", qdrant, reranker, signals, keys);
  }

  // =========================================================================
  // Unified strategy pipeline
  // =========================================================================

  /** Semantic (dense vector) search over a collection. */
  async semanticSearch(request: SemanticSearchRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    return this.executeExplore(
      this.vectorStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 10,
        filter: request.filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  /** Hybrid (dense + BM25 sparse) search over a collection. */
  async hybridSearch(request: HybridSearchRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    return this.executeExplore(
      this.hybridStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 10,
        filter: request.filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  /** Rank all chunks by rerank signals without vector search. */
  async rankChunks(request: RankChunksRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    return this.executeExplore(
      this.scrollRankStrategy,
      {
        collectionName,
        limit: request.limit ?? 10,
        offset: request.offset,
        level: request.level,
        filter: request.filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  // =========================================================================
  // Legacy search_code path (ExploreModule — will be migrated in Tasks 10-11)
  // =========================================================================

  /** Typed wrapper around searchCode — returns SearchCodeResponse. */
  async searchCodeTyped(request: SearchCodeRequest): Promise<SearchCodeResponse> {
    const options: SearchOptions = {
      limit: request.limit,
      fileTypes: request.fileTypes,
      pathPattern: request.pathPattern,
      documentationOnly: request.documentationOnly,
      author: request.author,
      modifiedAfter: request.modifiedAfter,
      modifiedBefore: request.modifiedBefore,
      minAgeDays: request.minAgeDays,
      maxAgeDays: request.maxAgeDays,
      minCommitCount: request.minCommitCount,
      taskId: request.taskId,
      rerank: request.rerank as SearchOptions["rerank"],
    };

    const rawResults = await this.searchCode(request.path, request.query, options);

    const results: SearchCodeResult[] = rawResults.map((r) => ({
      content: r.content,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      language: r.language,
      score: r.score,
      fileExtension: r.fileExtension,
      metadata: r.metadata as Record<string, unknown> | undefined,
    }));

    const driftWarning = this.schemaDriftMonitor ? await this.schemaDriftMonitor.checkAndConsume(request.path) : null;

    return { results, driftWarning };
  }

  /** Search code semantically (original API — legacy, uses ExploreModule). */
  async searchCode(path: string, query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    await this.ensureStats(collectionName);

    const { registry } = this;
    const filterBuilder = registry
      ? (params: Record<string, unknown>, level?: string) =>
          registry.buildFilter(params, (level as "chunk" | "file") ?? "chunk") as Record<string, unknown> | undefined
      : undefined;

    const search = new ExploreModule(
      this.qdrant,
      this.embeddings,
      this.config,
      this.reranker,
      collectionName,
      filterBuilder,
    );

    return search.searchCode(query, options);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Unified pipeline: validate → stats → strategy.execute → map → drift. */
  private async executeExplore(
    strategy: BaseExploreStrategy,
    ctx: ExploreContext,
    path?: string,
  ): Promise<SearchResponse> {
    await this.validateCollectionExists(ctx.collectionName, path);
    await this.ensureStats(ctx.collectionName);
    const results = await strategy.execute(ctx);
    const searchResults = this.toSearchResults(results);
    const driftWarning = await this.checkDrift(path, ctx.collectionName);
    return { results: searchResults, driftWarning };
  }

  private resolveCollection(collection?: string, path?: string): { collectionName: string; path?: string } {
    if (!collection && !path) {
      throw new CollectionRefError();
    }
    const collectionName = collection || resolveCollectionName(path as string);
    return { collectionName, path };
  }

  private async validateCollectionExists(collectionName: string, path?: string): Promise<void> {
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new CollectionNotFoundError(collectionName, path);
    }
  }

  private async ensureStats(collectionName: string): Promise<void> {
    if (this.statsCache && !this.reranker.hasCollectionStats) {
      try {
        const stats = this.statsCache.load(collectionName);
        if (stats) {
          this.reranker.setCollectionStats(stats);
        }
      } catch {
        // Stats loading failure should not prevent search
      }
    }
  }

  private toSearchResults(results: ExploreResult[]): SearchResult[] {
    return results.map((r) => ({
      id: r.id ?? "",
      score: r.score,
      payload: r.payload,
      rankingOverlay: r.rankingOverlay,
    }));
  }

  private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
    if (!this.schemaDriftMonitor) return null;
    if (path) return this.schemaDriftMonitor.checkAndConsume(path);
    if (collectionName) return this.schemaDriftMonitor.checkByCollectionName(collectionName);
    return null;
  }
}

export { CollectionRefError, CollectionNotFoundError };
