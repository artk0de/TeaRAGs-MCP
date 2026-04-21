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

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SignalLevel } from "../../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor, SignalStats } from "../../../contracts/types/trajectory.js";
import {
  CollectionNotFoundError as DomainCollectionNotFoundError,
  InvalidQueryError,
} from "../../../domains/explore/errors.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import {
  createExploreStrategy,
  FileOutlineStrategy,
  SimilarSearchStrategy,
  SymbolSearchStrategy,
  type BaseExploreStrategy,
  type ExploreContext,
} from "../../../domains/explore/strategies/index.js";
import { INDEXING_METADATA_ID } from "../../../domains/ingest/constants.js";
import { NotIndexedError } from "../../../domains/ingest/errors.js";
import { mapMarkerToHealth } from "../../../domains/ingest/pipeline/enrichment/health-mapper.js";
import type { EnrichmentMarkerMap } from "../../../domains/ingest/pipeline/enrichment/types.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import { resolveCollection, resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { SchemaDriftMonitor } from "../../../infra/schema-drift-monitor.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import { CollectionNotProvidedError, InvalidParameterError } from "../../errors.js";
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
  type SignalMetrics,
} from "../../public/dto/index.js";

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
  modelGuard?: EmbeddingModelGuard;
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
  private readonly payloadSignals: PayloadSignalDescriptor[];
  private readonly essentialKeys: string[];
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;
  private readonly modelGuard?: EmbeddingModelGuard;

  constructor(deps: ExploreFacadeDeps) {
    this.qdrant = deps.qdrant;
    this.modelGuard = deps.modelGuard;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.statsCache = deps.statsCache;
    this.schemaDriftMonitor = deps.schemaDriftMonitor;
    this.payloadSignals = deps.payloadSignals ?? [];
    this.essentialKeys = deps.essentialKeys ?? [];
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
  }

  // =========================================================================
  // Unified strategy pipeline
  // =========================================================================

  /** Semantic (dense vector) search over a collection. */
  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const rerank = this.resolveDocRerank(request.rerank, request.documentation, request.language);
    const level = resolveEffectiveLevel(request.level, rerank, this.reranker, "semantic_search");
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      level,
    );
    return this.executeExplore(
      this.vectorStrategy,
      {
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
      },
      path,
    );
  }

  /** Hybrid (dense + BM25 sparse) search over a collection. */
  async hybridSearch(request: HybridSearchRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const { embedding } = await this.embeddings.embed(request.query);
    const rerank = this.resolveDocRerank(request.rerank, request.documentation, request.language);
    const level = resolveEffectiveLevel(request.level, rerank, this.reranker, "semantic_search");
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      level,
    );
    return this.executeExplore(
      this.hybridStrategy,
      {
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
      },
      path,
    );
  }

  /** Rank all chunks by rerank signals without vector search. */
  async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "rank_chunks");
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      level,
    );
    return this.executeExplore(
      this.scrollRankStrategy,
      {
        collectionName,
        limit: request.limit ?? 10,
        offset: request.offset,
        level,
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
    await this.modelGuard?.ensureMatch(collectionName);
    const { embedding } = await this.embeddings.embed(request.query);
    const level = resolveEffectiveLevel(undefined, request.rerank, this.reranker, "search_code");
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      level,
    );
    return this.executeExplore(
      this.vectorStrategy,
      {
        collectionName,
        query: request.query,
        embedding,
        limit: request.limit ?? 5,
        offset: request.offset,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
      },
      absolutePath,
    );
  }

  /** Find similar chunks by ID or code block (find_similar MCP tool). */
  async findSimilar(request: FindSimilarRequest): Promise<ExploreResponse> {
    // Count meaningful inputs
    const hasPositive =
      (request.positiveIds?.length ?? 0) > 0 ||
      (request.positiveCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;
    const hasNegative =
      (request.negativeIds?.length ?? 0) > 0 ||
      (request.negativeCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;

    // Validate: strategy-specific constraints
    const strategy = request.strategy ?? "best_score";
    if (strategy !== "best_score" && !hasPositive) {
      throw new InvalidQueryError(`Strategy '${strategy}' requires at least one positive input`);
    }
    // best_score allows negative-only, but must have at least something
    if (!hasPositive && !hasNegative) {
      throw new InvalidQueryError("At least one positive or negative input is required");
    }

    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);

    // Create per-request strategy
    const similarStrategy = new SimilarSearchStrategy(
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
        strategy,
        fileExtensions: request.fileExtensions,
      },
    );

    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "semantic_search");
    const filter = this.registry.buildMergedFilter(
      request as unknown as Record<string, unknown>,
      request.filter,
      level,
    );
    return this.executeExplore(
      similarStrategy,
      {
        collectionName,
        limit: request.limit ?? 10,
        offset: request.offset,
        filter,
        pathPattern: request.pathPattern,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
        level,
      },
      path,
    );
  }

  /** Find symbol by name or file-level outline by relativePath. */
  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    validateFindSymbolRequest(request);
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);
    return this.executeExplore(
      this.buildFindSymbolStrategy(request),
      buildFindSymbolContext(request, collectionName),
      path,
    );
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

  // =========================================================================
  // Index metrics
  // =========================================================================

  /** Return collection-level signal statistics and distributions. */
  async getIndexMetrics(path: string): Promise<IndexMetrics> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    if (!(await this.qdrant.collectionExists(collectionName))) {
      throw new DomainCollectionNotFoundError(collectionName);
    }

    await this.ensureStats(collectionName);

    const stats = this.statsCache?.load(collectionName);
    if (!stats) {
      throw new NotIndexedError(path);
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const descriptors = this.payloadSignals;

    const buildSignalMetrics = (perSignal: Map<string, SignalStats>): Record<string, SignalMetrics> => {
      const result: Record<string, SignalMetrics> = {};
      for (const [key, signalStats] of perSignal) {
        const descriptor = descriptors.find((d) => d.key === key);
        if (!descriptor?.stats?.labels) continue;

        const labelMap: Record<string, number> = {};
        for (const [pKey, labelName] of Object.entries(descriptor.stats.labels)) {
          const p = Number(pKey.slice(1));
          const threshold = signalStats.percentiles[p];
          if (threshold !== undefined) {
            labelMap[labelName] = threshold;
          }
        }

        result[key] = {
          min: signalStats.min,
          max: signalStats.max,
          mean: signalStats.mean,
          count: signalStats.count,
          labelMap,
        };
      }
      return result;
    };

    const signals: Record<string, Record<string, Record<string, SignalMetrics>>> = {};

    if (stats.perLanguage) {
      for (const [lang, langStats] of stats.perLanguage) {
        const langSignals: Record<string, Record<string, SignalMetrics>> = {};
        for (const [key, scopedStats] of langStats) {
          const scoped: Record<string, SignalMetrics> = {};
          const sourceMetrics = buildSignalMetrics(new Map([[key, scopedStats.source]]));
          if (sourceMetrics[key]) {
            scoped["source"] = sourceMetrics[key];
          }
          if (scopedStats.test) {
            const testMetrics = buildSignalMetrics(new Map([[key, scopedStats.test]]));
            if (testMetrics[key]) {
              scoped["test"] = testMetrics[key];
            }
          }
          if (Object.keys(scoped).length > 0) {
            langSignals[key] = scoped;
          }
        }
        if (Object.keys(langSignals).length > 0) {
          signals[lang] = langSignals;
        }
      }
    }

    // Include global only for multi-language projects (>1 code language)
    const codeLanguageCount = stats.perLanguage?.size ?? 0;
    if (codeLanguageCount !== 1) {
      const globalMetrics = buildSignalMetrics(stats.perSignal);
      const globalScoped: Record<string, Record<string, SignalMetrics>> = {};
      for (const [key, metrics] of Object.entries(globalMetrics)) {
        globalScoped[key] = { source: metrics };
      }
      signals["global"] = globalScoped;
    }

    const markerPoint = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID).catch(() => null);
    const rawEnrichment = markerPoint?.payload?.enrichment as EnrichmentMarkerMap | undefined;
    const enrichmentHealth = rawEnrichment ? mapMarkerToHealth(rawEnrichment) : undefined;

    return {
      collection: collectionName,
      totalChunks: collectionInfo.pointsCount,
      totalFiles: stats.distributions.totalFiles,
      distributions: stats.distributions,
      signals,
      enrichment: enrichmentHealth,
    };
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

  /** Auto-apply documentationRelevance preset for doc searches without explicit rerank. */
  private resolveDocRerank(
    rerank: string | { custom: Record<string, number> } | undefined,
    documentation?: string,
    language?: string,
  ): string | { custom: Record<string, number> } | undefined {
    if (rerank) return rerank;
    if (documentation === "only" || language === "markdown") return "documentationRelevance";
    return rerank;
  }

  /**
   * Resolve collection + check model guard. Call BEFORE embed(query).
   * Guard reads Qdrant marker (no embed needed), so it catches model mismatch
   * before the embed call fails with OllamaModelMissingError.
   */
  private async resolveAndGuard(
    collection?: string,
    path?: string,
  ): Promise<{ collectionName: string; path?: string }> {
    if (!collection && !path) throw new CollectionNotProvidedError();
    const resolved = resolveCollection(collection, path);
    await this.validateCollectionExists(resolved.collectionName);
    await this.modelGuard?.ensureMatch(resolved.collectionName);
    return resolved;
  }

  private async validateCollectionExists(collectionName: string, _path?: string): Promise<void> {
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new DomainCollectionNotFoundError(collectionName);
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

/**
 * Resolve effective signal level: user override > preset signalLevel > "chunk" default.
 */
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

function validateFindSymbolRequest(request: FindSymbolRequest): void {
  if (request.symbol && request.relativePath) {
    throw new InvalidParameterError("symbol", "symbol and relativePath are mutually exclusive");
  }
  if (!request.symbol && !request.relativePath) {
    throw new InvalidParameterError("symbol", "either symbol or relativePath is required");
  }
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

export { DomainCollectionNotFoundError as CollectionNotFoundError };
