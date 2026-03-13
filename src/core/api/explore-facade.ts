/**
 * ExploreFacade — thin orchestrator for code exploration and search.
 *
 * Facade responsibilities (KEPT here):
 *   validateCollectionExists, ensureStats, embed query, checkDrift
 *
 * Delegated to infra:
 *   resolveCollection (infra/collection-name)
 *
 * Delegated to registry:
 *   buildMergedFilter (TrajectoryRegistry)
 *
 * Business logic (DELEGATED to strategies):
 *   fetchLimit, postProcess, metaOnly, BM25 generation, scroll+rank
 *
 * Cold-start: loads cached collection stats into reranker on first search.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import type { Reranker } from "../explore/reranker.js";
import { createExploreStrategy, type BaseExploreStrategy, type ExploreContext } from "../explore/strategies/index.js";
import {
  CollectionRefError,
  resolveCollection,
  resolveCollectionName,
  validatePath,
} from "../infra/collection-name.js";
import type { SchemaDriftMonitor } from "../infra/schema-drift-monitor.js";
import type { StatsCache } from "../infra/stats-cache.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type {
  ExploreCodeRequest,
  ExploreResponse,
  HybridSearchRequest,
  RankChunksRequest,
  SemanticSearchRequest,
} from "./app.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class CollectionNotFoundError extends Error {
  constructor(collectionName: string, path?: string) {
    super(`Collection "${collectionName}" does not exist.${path ? ` Codebase at "${path}" may not be indexed.` : ""}`);
    this.name = "CollectionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// ExploreFacadeDeps
// ---------------------------------------------------------------------------

export interface ExploreFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  statsCache?: StatsCache;
  schemaDriftMonitor?: SchemaDriftMonitor;
  payloadSignals?: PayloadSignalDescriptor[];
  essentialKeys?: string[];
}

// ---------------------------------------------------------------------------
// ExploreFacade
// ---------------------------------------------------------------------------

export class ExploreFacade {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly reranker: Reranker;
  private readonly registry: TrajectoryRegistry;
  private readonly statsCache?: StatsCache;
  private readonly schemaDriftMonitor?: SchemaDriftMonitor;
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;

  constructor(deps: ExploreFacadeDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.statsCache = deps.statsCache;
    this.schemaDriftMonitor = deps.schemaDriftMonitor;
    const signals = deps.payloadSignals ?? [];
    const keys = deps.essentialKeys ?? [];
    this.vectorStrategy = createExploreStrategy("vector", deps.qdrant, deps.reranker, signals, keys);
    this.hybridStrategy = createExploreStrategy("hybrid", deps.qdrant, deps.reranker, signals, keys);
    this.scrollRankStrategy = createExploreStrategy("scroll-rank", deps.qdrant, deps.reranker, signals, keys);
  }

  // =========================================================================
  // Unified strategy pipeline
  // =========================================================================

  /** Semantic (dense vector) search over a collection. */
  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    const { collectionName, path } = resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const filter = this.registry.buildMergedFilter(request as unknown as Record<string, unknown>, request.filter);
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
    const { collectionName, path } = resolveCollection(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const filter = this.registry.buildMergedFilter(request as unknown as Record<string, unknown>, request.filter);
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
    const { collectionName, path } = resolveCollection(request.collection, request.path);
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      request.level,
    );
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

  /** Search code semantically (search_code MCP tool). */
  async searchCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
    const absolutePath = await validatePath(request.path);
    const collectionName = resolveCollectionName(absolutePath);
    const { embedding } = await this.embeddings.embed(request.query);
    const filter = this.registry.buildMergedFilter(request as unknown as Record<string, unknown>, request.filter);
    return this.executeExplore(
      this.vectorStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 5,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
      },
      absolutePath,
    );
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

  private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
    if (!this.schemaDriftMonitor) return null;
    if (path) return this.schemaDriftMonitor.checkAndConsume(path);
    if (collectionName) return this.schemaDriftMonitor.checkByCollectionName(collectionName);
    return null;
  }
}

export { CollectionRefError, CollectionNotFoundError };
