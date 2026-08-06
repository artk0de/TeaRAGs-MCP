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
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { mergeQdrantFilters } from "../../../adapters/qdrant/filters/utils.js";
import type { QdrantFilter } from "../../../adapters/qdrant/types.js";
import type { SymbolChunkResolver } from "../../../contracts/types/codegraph.js";
import type { FilterPresetDef, FilterSpec } from "../../../contracts/types/filter-preset.js";
import type { FilterLevel } from "../../../contracts/types/provider.js";
import type { SignalLevel } from "../../../contracts/types/reranker.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalFloors,
} from "../../../contracts/types/trajectory.js";
import {
  CollectionNotFoundError as DomainCollectionNotFoundError,
  EmptyFilterPresetError,
  UnknownFilterPresetError,
} from "../../../domains/explore/errors.js";
import { computeSearchConfidence, type SearchConfidenceInput } from "../../../domains/explore/index.js";
import { IndexMetricsQuery } from "../../../domains/explore/queries/index-metrics.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import {
  createExploreStrategy,
  FileOutlineStrategy,
  SimilarSearchStrategy,
  SymbolSearchStrategy,
  type BaseExploreStrategy,
  type ExploreContext,
  type ExploreResult,
} from "../../../domains/explore/strategies/index.js";
import { NotIndexedError } from "../../../domains/ingest/errors.js";
import { StatsRecomputeService } from "../../../domains/ingest/infra/stats-recompute.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import type { SchemaDriftMonitor } from "../../../domains/maintenance/schema-drift-monitor.js";
import { compileFilterPreset } from "../../../domains/trajectory/filter-presets/compiler.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
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
import { resolveCollection } from "../collection-resolver.js";

export interface ExploreOpsDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  collectionRegistry: CollectionRegistry;
  statsCache?: StatsCache;
  schemaDriftMonitor?: SchemaDriftMonitor;
  payloadSignals: PayloadSignalDescriptor[];
  essentialKeys: string[];
  modelGuard?: EmbeddingModelGuard;
  /** Optional — present when codegraph is wired (bootstrap adapts GraphFacade). */
  chunkResolver?: SymbolChunkResolver;
  /**
   * Per-language structural-signal floors from the composition root. Reaches
   * `IndexMetricsQuery` so `get_index_metrics` and prime render the same
   * floored thresholds the reranker's overlay resolves against.
   */
  signalFloors?: ReadonlyMap<string, SignalFloors>;
}

export class ExploreOps {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly reranker: Reranker;
  private readonly registry: TrajectoryRegistry;
  private readonly collectionRegistry: CollectionRegistry;
  private readonly statsCache?: StatsCache;
  private readonly schemaDriftMonitor?: SchemaDriftMonitor;
  private readonly payloadSignals: PayloadSignalDescriptor[];
  private readonly essentialKeys: string[];
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;
  private readonly indexMetricsQuery?: IndexMetricsQuery;
  private readonly recomputeService?: StatsRecomputeService;
  private readonly chunkResolver?: SymbolChunkResolver;

  constructor(deps: ExploreOpsDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.collectionRegistry = deps.collectionRegistry;
    this.statsCache = deps.statsCache;
    this.schemaDriftMonitor = deps.schemaDriftMonitor;
    this.payloadSignals = deps.payloadSignals;
    this.essentialKeys = deps.essentialKeys;
    this.modelGuard = deps.modelGuard;
    this.chunkResolver = deps.chunkResolver;
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
      this.indexMetricsQuery = new IndexMetricsQuery(
        deps.qdrant,
        deps.statsCache,
        this.payloadSignals,
        deps.signalFloors,
      );
      this.recomputeService = new StatsRecomputeService(deps.qdrant, deps.statsCache);
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
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path, request.project);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "rank_chunks");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const filter = this.buildFilter(request, level, "rank_chunks");
    return this.executeExplore(
      this.scrollRankStrategy,
      buildRankChunksContext(request, collectionName, filter, level),
      path,
    );
  }

  async searchCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
    const { collectionName, path } = resolveCollection(this.collectionRegistry, {
      collection: request.collection,
      project: request.project,
      path: request.path,
    });
    await this.modelGuard?.ensureMatch(collectionName);
    const { embedding } = await this.embeddings.embed(request.query);
    const level = resolveEffectiveLevel(undefined, request.rerank, this.reranker, "search_code");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const filter = this.buildFilter(request, level, "search_code");
    return this.executeExplore(
      this.vectorStrategy,
      buildSearchCodeContext(request, collectionName, embedding, filter),
      path,
    );
  }

  async findSimilar(request: FindSimilarRequest, strategy: SimilarSearchStrategy): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path, request.project);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "semantic_search");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const filter = this.buildFilter(request, level);
    return this.executeExplore(strategy, buildFindSimilarContext(request, collectionName, filter, level), path, true);
  }

  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path, request.project);
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

  /**
   * Unified pipeline: ensureStats → strategy.execute → shape → drift warning.
   *
   * `attachConfidence` is opt-in per operation rather than global: the shape of
   * the score distribution only answers "is this in the project" where the
   * score came from a semantic comparison. On rank_chunks (scroll + rerank) and
   * find_symbol (exact lookup) it would be a number attesting nothing.
   */
  private async executeExplore(
    strategy: BaseExploreStrategy,
    ctx: ExploreContext,
    path?: string,
    attachConfidence = false,
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
      ...(attachConfidence ? { confidence: computeSearchConfidence(toConfidenceInput(results)) } : {}),
    };
  }

  /** Shared flow for semantic + hybrid: embed → resolveDocRerank → level → filter → execute. */
  private async embedAndDispatch(
    request: SemanticSearchRequest | HybridSearchRequest,
    strategy: BaseExploreStrategy,
  ): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path, request.project);
    const { embedding } = await this.embeddings.embed(request.query);
    const rerank = resolveDocRerank(request.rerank, request.documentation, request.language);
    const level = resolveEffectiveLevel(request.level, rerank, this.reranker, "semantic_search");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const filter = this.buildFilter(request, level);
    return this.executeExplore(
      strategy,
      buildVectorSearchContext(request, collectionName, embedding, filter, rerank, level),
      path,
      true,
    );
  }

  /**
   * Resolve the user `filter` param (raw OR {presets}) against the rerank
   * preset's `filter` default, then merge with typed filter params via the
   * registry.
   *
   * Resolution order: replace-semantics ({presets}/raw param wins over preset
   * default, {} clears) happens FIRST in `resolveFilterSpec`, yielding a plain
   * Qdrant filter; that resolved object is then handed to `buildMergedFilter`
   * which AND-merges it with the typed params. Collection stats (loaded by
   * `ensureStats` before this runs) feed the preset compiler's adaptive
   * percentile thresholds.
   */
  private buildFilter(
    request: Record<string, unknown> | { filter?: Record<string, unknown> },
    level: SignalLevel | undefined,
    tool: "semantic_search" | "search_code" | "rank_chunks" = "semantic_search",
  ): Record<string, unknown> | undefined {
    const req = request as Record<string, unknown> & { filter?: FilterSpec; rerank?: unknown };
    const presetName = typeof req.rerank === "string" ? req.rerank : undefined;
    const presetDefault = presetName ? this.reranker.getFullPreset(presetName, tool)?.filter : undefined;
    const stats = this.reranker.getCollectionStats();
    const resolved = resolveFilterSpec(req.filter, presetDefault, stats, level ?? "chunk", this.registry);
    return this.registry.buildMergedFilter(req, resolved, level);
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
      this.chunkResolver,
    );
  }

  /**
   * Resolve collection + check model guard. Call BEFORE embed(query) so
   * model mismatch is caught via the Qdrant marker (no embed roundtrip).
   */
  private async resolveAndGuard(
    collection?: string,
    path?: string,
    project?: string,
  ): Promise<{ collectionName: string; path?: string }> {
    const resolved = resolveCollection(this.collectionRegistry, { collection, project, path });
    const exists = await this.qdrant.collectionExists(resolved.collectionName);
    if (!exists) throw new DomainCollectionNotFoundError(resolved.collectionName);
    await this.modelGuard?.ensureMatch(resolved.collectionName);
    return resolved;
  }

  private async ensureStats(collectionName: string): Promise<void> {
    if (!this.statsCache || this.reranker.hasCollectionStats) return;
    try {
      const stats = this.statsCache.load(collectionName);
      if (!stats) return;
      // Wire the recompute service into the reranker so lazy-at-rerank
      // backfill of missing confidence-referenced percentiles can fire
      // at the moment of need (inside Reranker.rerank). No scroll fires
      // here at load time — only at the first rerank that actually
      // consults a missing percentile.
      if (this.recomputeService) {
        this.reranker.setRecomputeService(this.recomputeService);
      }
      this.reranker.setCollectionStats(stats, {
        collectionName,
        payloadFieldKeys: stats.payloadFieldKeys,
      });
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

/**
 * Reduce strategy output to the two fields the shape statistics read. Works for
 * both full and metaOnly result shapes — `relativePath` sits on the payload in
 * either case.
 */
function toConfidenceInput(results: readonly ExploreResult[]): SearchConfidenceInput[] {
  return results.map((r) => ({
    score: r.score,
    relativePath: typeof r.payload?.relativePath === "string" ? r.payload.relativePath : undefined,
  }));
}

/** Minimal registry surface resolveFilterSpec needs — pure preset-def lookup. */
interface FilterPresetLookup {
  getFilterPresetDef: (name: string) => FilterPresetDef | undefined;
}

/** Narrow a FilterSpec to its `{presets}` variant (string `presets` field present). */
function isPresetsSpec(spec: FilterSpec): spec is { presets: string } {
  return typeof (spec as { presets?: unknown }).presets === "string";
}

/**
 * Resolve a `filter` spec (raw Qdrant filter OR `{presets}` CSV) against the
 * rerank preset's `filter` default, returning a plain Qdrant filter object.
 *
 * REPLACE semantics: an explicit `spec` wins outright over `presetDefault` —
 * the default only fills the slot when no param was given (default-argument
 * mental model). An explicit empty object `{}` clears the default (returns
 * undefined). `{presets}` is CSV-resolved against the registry, each named
 * preset compiled with collection stats and AND-merged.
 *
 * Lives here (api/internal) rather than the trajectory registry per domain
 * isolation: this layer may legally import the compiler (trajectory), the
 * typed errors (explore), and the filter merge (adapters).
 */
export function resolveFilterSpec(
  spec: FilterSpec | undefined,
  presetDefault: FilterSpec | undefined,
  stats: CollectionSignalStats | undefined,
  level: FilterLevel,
  registry: FilterPresetLookup,
): Record<string, unknown> | undefined {
  const effective = spec ?? presetDefault;
  if (effective === undefined) return undefined;
  // Explicit empty object clears the preset default.
  if (Object.keys(effective).length === 0) return undefined;

  if (isPresetsSpec(effective)) {
    const names = effective.presets
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) throw new EmptyFilterPresetError(effective.presets);

    let merged: QdrantFilter | undefined;
    for (const name of names) {
      const def = registry.getFilterPresetDef(name);
      if (!def) throw new UnknownFilterPresetError(name);
      merged = mergeQdrantFilters(merged, compileFilterPreset(def, stats, level));
    }
    return merged as Record<string, unknown> | undefined;
  }

  // Raw filter — pass through as-is.
  return effective;
}

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
