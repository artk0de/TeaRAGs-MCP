/**
 * ExploreOps — orchestrates the explore pipeline for ExploreFacade.
 *
 * Extracted from ExploreFacade to keep the facade as a pure delegation
 * surface. This class owns the full search pipeline: collection guard,
 * cold-start stats, embedding, filter merging, strategy execution,
 * drift warning. It also holds the shared strategy instances
 * (vector/hybrid/scroll-rank) and the index metrics query.
 *
 * Input validation is the facade's responsibility — validators run
 * BEFORE delegation to ExploreOps.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SignalLevel } from "../../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { CollectionNotFoundError as DomainCollectionNotFoundError } from "../../../domains/explore/errors.js";
import { IndexMetricsQuery } from "../../../domains/explore/queries/index-metrics.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import {
  createExploreStrategy,
  FileOutlineStrategy,
  SimilarSearchStrategy,
  SymbolSearchStrategy,
  type BaseExploreStrategy,
  type ExploreContext,
} from "../../../domains/explore/strategies/index.js";
import { NotIndexedError } from "../../../domains/ingest/errors.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import { resolveCollection, resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { SchemaDriftMonitor } from "../../../infra/schema-drift-monitor.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import { CollectionNotProvidedError } from "../../errors.js";
import {
  stripInternalFields,
  type ExploreCodeRequest,
  type ExploreResponse,
  type FindSimilarRequest,
  type FindSymbolRequest,
  type HybridSearchRequest,
  type IndexMetrics,
  type RankChunksRequest,
  type SemanticSearchRequest,
} from "../../public/dto/index.js";

export interface ExploreOpsDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  statsCache?: StatsCache;
  schemaDriftMonitor?: SchemaDriftMonitor;
  payloadSignals: PayloadSignalDescriptor[];
  essentialKeys: string[];
  modelGuard?: EmbeddingModelGuard;
}

export class ExploreOps {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly reranker: Reranker;
  private readonly registry: TrajectoryRegistry;
  private readonly statsCache?: StatsCache;
  private readonly schemaDriftMonitor?: SchemaDriftMonitor;
  private readonly payloadSignals: PayloadSignalDescriptor[];
  private readonly essentialKeys: string[];
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;
  private readonly indexMetricsQuery?: IndexMetricsQuery;

  constructor(deps: ExploreOpsDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.statsCache = deps.statsCache;
    this.schemaDriftMonitor = deps.schemaDriftMonitor;
    this.payloadSignals = deps.payloadSignals;
    this.essentialKeys = deps.essentialKeys;
    this.modelGuard = deps.modelGuard;
    this.vectorStrategy = createExploreStrategy(
      "vector",
      deps.qdrant,
      deps.reranker,
      this.payloadSignals,
      this.essentialKeys,
    );
    this.hybridStrategy = createExploreStrategy(
      "hybrid",
      deps.qdrant,
      deps.reranker,
      this.payloadSignals,
      this.essentialKeys,
    );
    this.scrollRankStrategy = createExploreStrategy(
      "scroll-rank",
      deps.qdrant,
      deps.reranker,
      this.payloadSignals,
      this.essentialKeys,
    );
    if (deps.statsCache) {
      this.indexMetricsQuery = new IndexMetricsQuery(deps.qdrant, deps.statsCache, this.payloadSignals);
    }
  }

  // ---------------------------------------------------------------------------
  // Public operations — one per App interface method
  // ---------------------------------------------------------------------------

  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    return this.embedAndDispatch(request, this.vectorStrategy);
  }

  async hybridSearch(request: HybridSearchRequest): Promise<ExploreResponse> {
    return this.embedAndDispatch(request, this.hybridStrategy);
  }

  async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "rank_chunks");
    const filter = this.buildFilter(request, level);
    return this.executeExplore(
      this.scrollRankStrategy,
      buildRankChunksContext(request, collectionName, filter, level),
      path,
    );
  }

  async searchCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
    const absolutePath = await validatePath(request.path);
    const collectionName = resolveCollectionName(absolutePath);
    await this.modelGuard?.ensureMatch(collectionName);
    const { embedding } = await this.embeddings.embed(request.query);
    const level = resolveEffectiveLevel(undefined, request.rerank, this.reranker, "search_code");
    const filter = this.buildFilter(request, level);
    return this.executeExplore(
      this.vectorStrategy,
      buildSearchCodeContext(request, collectionName, embedding, filter),
      absolutePath,
    );
  }

  async findSimilar(request: FindSimilarRequest, strategy: SimilarSearchStrategy): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "semantic_search");
    const filter = this.buildFilter(request, level);
    return this.executeExplore(strategy, buildFindSimilarContext(request, collectionName, filter, level), path);
  }

  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    return this.executeExplore(
      this.buildFindSymbolStrategy(request),
      buildFindSymbolContext(request, collectionName),
      path,
    );
  }

  async getIndexMetrics(path: string): Promise<IndexMetrics> {
    if (!this.indexMetricsQuery) throw new NotIndexedError(path);
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    await this.ensureStats(collectionName);
    return this.indexMetricsQuery.run(collectionName, path);
  }

  /** Factory for the per-request findSimilar strategy. Exposed so facade can construct without reaching into ops internals. */
  buildSimilarStrategy(request: FindSimilarRequest): SimilarSearchStrategy {
    return new SimilarSearchStrategy(
      this.qdrant,
      this.reranker,
      this.payloadSignals,
      this.essentialKeys,
      this.embeddings,
      {
        positiveIds: request.positiveIds,
        positiveCode: request.positiveCode,
        negativeIds: request.negativeIds,
        negativeCode: request.negativeCode,
        strategy: request.strategy ?? "best_score",
        fileExtensions: request.fileExtensions,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Private pipeline helpers
  // ---------------------------------------------------------------------------

  /** Unified pipeline: ensureStats → strategy.execute → shape → drift warning. */
  private async executeExplore(
    strategy: BaseExploreStrategy,
    ctx: ExploreContext,
    path?: string,
  ): Promise<ExploreResponse> {
    await this.ensureStats(ctx.collectionName);
    const results = await strategy.execute(ctx);
    const driftWarning = await this.checkDrift(path, ctx.collectionName);
    return {
      results: results.map((r) => ({
        id: r.id ?? "",
        score: r.score,
        payload: r.payload ? stripInternalFields(r.payload) : r.payload,
        rankingOverlay: r.rankingOverlay,
      })),
      driftWarning,
      ...(ctx.level ? { level: ctx.level } : {}),
    };
  }

  /** Shared flow for semantic + hybrid: embed → resolveDocRerank → level → filter → execute. */
  private async embedAndDispatch(
    request: SemanticSearchRequest | HybridSearchRequest,
    strategy: BaseExploreStrategy,
  ): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const rerank = resolveDocRerank(request.rerank, request.documentation, request.language);
    const level = resolveEffectiveLevel(request.level, rerank, this.reranker, "semantic_search");
    const filter = this.buildFilter(request, level);
    return this.executeExplore(
      strategy,
      buildVectorSearchContext(request, collectionName, embedding, filter, rerank, level),
      path,
    );
  }

  /** Merge typed filter params with raw filter via registry. */
  private buildFilter(
    request: Record<string, unknown> | { filter?: Record<string, unknown> },
    level: SignalLevel | undefined,
  ): Record<string, unknown> | undefined {
    const req = request as Record<string, unknown> & { filter?: Record<string, unknown> };
    return this.registry.buildMergedFilter(req, req.filter, level);
  }

  private buildFindSymbolStrategy(request: FindSymbolRequest): BaseExploreStrategy {
    if (request.relativePath) {
      return new FileOutlineStrategy(this.qdrant, this.reranker, this.payloadSignals, this.essentialKeys, {
        relativePath: request.relativePath,
        language: request.language,
      });
    }
    return new SymbolSearchStrategy(
      this.qdrant,
      this.reranker,
      this.payloadSignals,
      this.essentialKeys,
      this.registry,
      {
        symbol: request.symbol as string,
        language: request.language,
        pathPattern: request.pathPattern,
      },
    );
  }

  /**
   * Resolve collection + check model guard. Call BEFORE embed(query) so
   * model mismatch is caught via the Qdrant marker (no embed roundtrip).
   */
  private async resolveAndGuard(
    collection?: string,
    path?: string,
  ): Promise<{ collectionName: string; path?: string }> {
    if (!collection && !path) throw new CollectionNotProvidedError();
    const resolved = resolveCollection(collection, path);
    const exists = await this.qdrant.collectionExists(resolved.collectionName);
    if (!exists) throw new DomainCollectionNotFoundError(resolved.collectionName);
    await this.modelGuard?.ensureMatch(resolved.collectionName);
    return resolved;
  }

  private async ensureStats(collectionName: string): Promise<void> {
    if (!this.statsCache || this.reranker.hasCollectionStats) return;
    try {
      const stats = this.statsCache.load(collectionName);
      if (stats) this.reranker.setCollectionStats(stats);
    } catch {
      // Stats loading failure must not prevent search.
    }
  }

  private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
    if (!this.schemaDriftMonitor) return null;
    if (path) return this.schemaDriftMonitor.checkAndConsume(path);
    if (collectionName) return this.schemaDriftMonitor.checkByCollectionName(collectionName);
    return null;
  }
}

// ---------------------------------------------------------------------------
// File-local helpers (pure functions)
// ---------------------------------------------------------------------------

/** Auto-apply documentationRelevance preset for doc searches without explicit rerank. */
function resolveDocRerank(
  rerank: string | { custom: Record<string, number> } | undefined,
  documentation?: string,
  language?: string,
): string | { custom: Record<string, number> } | undefined {
  if (rerank) return rerank;
  if (documentation === "only" || language === "markdown") return "documentationRelevance";
  return rerank;
}

/** Resolve effective signal level: user override > preset signalLevel > default. */
function resolveEffectiveLevel(
  userLevel: SignalLevel | undefined,
  rerank: string | { custom: Record<string, number> } | undefined,
  reranker: Reranker,
  tool: "semantic_search" | "search_code" | "rank_chunks",
): SignalLevel | undefined {
  if (userLevel) return userLevel;
  if (typeof rerank === "string") {
    const preset = reranker.getFullPreset(rerank, tool);
    return preset?.signalLevel;
  }
  return undefined;
}

function buildVectorSearchContext(
  request: SemanticSearchRequest | HybridSearchRequest,
  collectionName: string,
  embedding: number[],
  filter: Record<string, unknown> | undefined,
  rerank: SemanticSearchRequest["rerank"],
  level: SignalLevel | undefined,
): ExploreContext {
  return {
    collectionName,
    query: request.query,
    embedding,
    limit: request.limit ?? 10,
    offset: request.offset,
    filter,
    pathPattern: request.pathPattern,
    rerank,
    metaOnly: request.metaOnly,
    level,
  };
}

function buildRankChunksContext(
  request: RankChunksRequest,
  collectionName: string,
  filter: Record<string, unknown> | undefined,
  level: SignalLevel | undefined,
): ExploreContext {
  return {
    collectionName,
    limit: request.limit ?? 10,
    offset: request.offset,
    level,
    filter,
    pathPattern: request.pathPattern,
    rerank: request.rerank,
    metaOnly: request.metaOnly,
  };
}

function buildSearchCodeContext(
  request: ExploreCodeRequest,
  collectionName: string,
  embedding: number[],
  filter: Record<string, unknown> | undefined,
): ExploreContext {
  return {
    collectionName,
    query: request.query,
    embedding,
    limit: request.limit ?? 5,
    offset: request.offset,
    filter,
    pathPattern: request.pathPattern,
    rerank: request.rerank,
  };
}

function buildFindSimilarContext(
  request: FindSimilarRequest,
  collectionName: string,
  filter: Record<string, unknown> | undefined,
  level: SignalLevel | undefined,
): ExploreContext {
  return {
    collectionName,
    limit: request.limit ?? 10,
    offset: request.offset,
    filter,
    pathPattern: request.pathPattern,
    rerank: request.rerank,
    metaOnly: request.metaOnly,
    level,
  };
}

function buildFindSymbolContext(request: FindSymbolRequest, collectionName: string): ExploreContext {
  return {
    collectionName,
    limit: request.limit ?? 50,
    offset: request.offset,
    rerank: request.rerank,
    metaOnly: request.metaOnly,
  };
}
