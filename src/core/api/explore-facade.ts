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
import { createExploreStrategy, type BaseExploreStrategy, type ExploreContext } from "../explore/strategies/index.js";
import type { SchemaDriftMonitor } from "../infra/schema-drift-monitor.js";
import type { StatsCache } from "../infra/stats-cache.js";
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type { ExploreCodeConfig, SearchOptions } from "../types.js";
import type {
  ExploreCodeRequest,
  ExploreResponse,
  HybridSearchRequest,
  RankChunksRequest,
  SearchCodeResponse,
  SearchCodeResult,
  SemanticSearchRequest,
  TypedFilterParams,
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
  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const filter = this.buildMergedFilter(request, request.filter);
    return this.executeExplore(
      this.vectorStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 10,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  /** Hybrid (dense + BM25 sparse) search over a collection. */
  async hybridSearch(request: HybridSearchRequest): Promise<ExploreResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const filter = this.buildMergedFilter(request, request.filter);
    return this.executeExplore(
      this.hybridStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 10,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  /** Rank all chunks by rerank signals without vector search. */
  async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    const filter = this.buildMergedFilter(request, request.filter, request.level);
    return this.executeExplore(
      this.scrollRankStrategy,
      {
        collectionName,
        limit: request.limit ?? 10,
        offset: request.offset,
        level: request.level,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      },
      path,
    );
  }

  /** Search code semantically via ExploreModule (search_code MCP tool). */
  async searchCode(request: ExploreCodeRequest): Promise<SearchCodeResponse> {
    const absolutePath = await validatePath(request.path);
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

    const rawResults = await search.searchCode(request.query, options);

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

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Unified pipeline: validate → stats → strategy.execute → map → drift. */
  private async executeExplore(
    strategy: BaseExploreStrategy,
    ctx: ExploreContext,
    path?: string,
  ): Promise<ExploreResponse> {
    await this.validateCollectionExists(ctx.collectionName, path);
    await this.ensureStats(ctx.collectionName);
    const results = await strategy.execute(ctx);
    const driftWarning = await this.checkDrift(path, ctx.collectionName);
    return {
      results: results.map((r) => ({
        id: r.id ?? "",
        score: r.score,
        payload: r.payload,
        rankingOverlay: r.rankingOverlay,
      })),
      driftWarning,
    };
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

  /**
   * Merge typed filter params (via registry) with raw Qdrant filter.
   * Typed must/must_not are appended to raw filter's arrays.
   * Raw filter's should is preserved untouched.
   */
  private buildMergedFilter(
    typedParams: TypedFilterParams,
    rawFilter?: Record<string, unknown>,
    level: "chunk" | "file" = "chunk",
  ): Record<string, unknown> | undefined {
    const typedFilter = this.registry?.buildFilter(typedParams as Record<string, unknown>, level);
    if (!typedFilter && !rawFilter) return undefined;
    if (!typedFilter) return rawFilter;
    if (!rawFilter) return typedFilter as Record<string, unknown>;

    const merged: Record<string, unknown> = { ...rawFilter };
    const rawMust = Array.isArray(rawFilter.must) ? (rawFilter.must as unknown[]) : [];
    const typedMust = Array.isArray(typedFilter.must) ? (typedFilter.must as unknown[]) : [];
    if (rawMust.length > 0 || typedMust.length > 0) {
      merged.must = [...rawMust, ...typedMust];
    }

    const rawMustNot = Array.isArray(rawFilter.must_not) ? (rawFilter.must_not as unknown[]) : [];
    const typedMustNot = Array.isArray(typedFilter.must_not) ? (typedFilter.must_not as unknown[]) : [];
    if (rawMustNot.length > 0 || typedMustNot.length > 0) {
      merged.must_not = [...rawMustNot, ...typedMustNot];
    }

    return merged;
  }

  private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
    if (!this.schemaDriftMonitor) return null;
    if (path) return this.schemaDriftMonitor.checkAndConsume(path);
    if (collectionName) return this.schemaDriftMonitor.checkByCollectionName(collectionName);
    return null;
  }
}

export { CollectionRefError, CollectionNotFoundError };
