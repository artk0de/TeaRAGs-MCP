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

import { resolve } from "node:path";

import {
  READ_PATH_EMBEDDING_RECOVERY_WAIT_MS,
  type EmbeddingCallOptions,
  type EmbeddingProvider,
} from "../../../adapters/embeddings/base.js";
import { isEmbeddingProviderUnavailable } from "../../../adapters/embeddings/errors.js";
import type { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { mergeQdrantFilters } from "../../../adapters/qdrant/filters/utils.js";
import type { EmbeddingModelGuardCallOptions, EmbeddingModelGuardPort } from "../../../adapters/qdrant/ports.js";
import type { QdrantFilter } from "../../../adapters/qdrant/types.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import { TEST_CHUNK_TYPES } from "../../../contracts/types/chunker.js";
import type {
  ContainerAncestorResolver,
  SymbolChunkResolver,
  SymbolVisibilityResolver,
} from "../../../contracts/types/codegraph.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { FilterPresetDef, FilterSpec } from "../../../contracts/types/filter-preset.js";
import type { FilterLevel } from "../../../contracts/types/provider.js";
import type { RegistryLookup } from "../../../contracts/types/registry.js";
import type { SignalLevel } from "../../../contracts/types/reranker.js";
import type { SymbolBatchMiss } from "../../../contracts/types/symbol-batch.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalFloors,
} from "../../../contracts/types/trajectory.js";
import type { WorkingTree, WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import {
  computeSearchConfidence,
  createExploreStrategy,
  EmptyFilterPresetError,
  FileOutlineStrategy,
  IndexMetricsQuery,
  MIGRATION_ID_PREFIX,
  MigrationCorpusQuery,
  outlineAddressOf,
  QUERY_VARIANT_SEPARATOR,
  RAILS_TABLE_ID_PREFIX,
  SimilarSearchStrategy,
  splitQueryVariants,
  SymbolBatchDrill,
  SymbolMissExplainer,
  SymbolSearchStrategy,
  UnknownFilterPresetError,
  withoutWorkingTreeFloors,
  type BaseExploreStrategy,
  type ExploreContext,
  type ExploreQueryVariant,
  type ExploreRequestScope,
  type ExploreResult,
  type RerankerPort,
  type SearchConfidenceInput,
  type WorkingTreeOverlay,
  type WorkingTreeView,
} from "../../../domains/explore/index.js";
import { NotIndexedError } from "../../../domains/ingest/errors/index.js";
import { migrationCollectionName } from "../../../domains/ingest/index.js";
import { StatsRecomputeService } from "../../../domains/ingest/infra/index.js";
import { DOCUMENTATION_LANGUAGES } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { mapMarkerToHealth } from "../../../domains/ingest/pipeline/enrichment/index.js";
import { foldRailsTableMigrations } from "../../../domains/language/index.js";
import { compileFilterPreset, type TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import {
  projectSearchResultPayloads,
  stripInternalFields,
  type ExploreCodeRequest,
  type ExploreResponse,
  type FindSimilarRequest,
  type FindSymbolRequest,
  type HybridSearchRequest,
  type IndexMetrics,
  type IndexMetricsReadOptions,
  type PresetFilterNotice,
  type RankChunksRequest,
  type SemanticSearchRequest,
  type WorkingTreeIndexTarget,
} from "../../public/dto/index.js";
import type { CollectionEmbeddingBinding, CollectionEmbeddingsResolver } from "../collection-embeddings.js";
import { resolveIndexedWorkingTree, resolveWorkingTree } from "../collection-resolver.js";
import type { IndexHistoryAnchorResolver } from "../infra/index-history-anchor.js";
import { explainEmptySearch } from "./empty-search-explanation.js";

export interface ExploreOpsDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: RerankerPort;
  registry: TrajectoryRegistry;
  collectionRegistry: RegistryLookup;
  statsCache?: StatsCache;
  payloadSignals: PayloadSignalDescriptor[];
  essentialKeys: string[];
  modelGuard?: EmbeddingModelGuardPort;
  /**
   * The provider and guard that embed on behalf of a collection — its REGISTRY
   * entry's model, not this process's (bd tea-rags-mcp-b91f5). Absent (unit
   * wiring) → `embeddings` + `modelGuard` serve every collection.
   */
  collectionEmbeddings?: CollectionEmbeddingsResolver;
  /** Optional — present when codegraph is wired (bootstrap adapts GraphFacade). */
  chunkResolver?: SymbolChunkResolver;
  /**
   * Optional — present when codegraph is wired. Declared visibility for
   * find_symbol outline lines (bd tea-rags-mcp-sqqkz); absent → undecorated.
   */
  visibilityResolver?: SymbolVisibilityResolver;
  /**
   * Optional — present when codegraph is wired. Direct ancestors for
   * find_symbol class outlines (bd tea-rags-mcp-82cot); absent → none listed.
   */
  containerAncestorResolver?: ContainerAncestorResolver;
  /**
   * Per-language structural-signal floors from the composition root. Reaches
   * `IndexMetricsQuery` so `get_index_metrics` and prime render the same
   * floored thresholds the reranker's overlay resolves against.
   */
  signalFloors?: ReadonlyMap<string, SignalFloors>;
  /**
   * Provider keys of the ingest slice serving a path, handed to
   * `IndexMetricsQuery` per request. `get_index_metrics` therefore frames
   * enrichment health on the composition, not on the last run's provider list
   * (bd tea-rags-mcp-x2u65), and on the PROJECT's composition, the one its
   * `get_index_status` frames on, not the server's (bd tea-rags-mcp-uebug).
   * Omitted → no frame, and a run-pointer marker reports no providers.
   */
  enrichmentHealthFrameForPath?: (path: string) => readonly string[];
  /**
   * Measures the tree a request reads against its index (bd tea-rags-mcp-xi2r9).
   * Present → every answer carries `workingTree`; absent (unit wiring) → none.
   */
  workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  /**
   * The query clock of an index (bd tea-rags-mcp-zwu7m): a head-anchored index
   * reads at its indexed commit's time. Absent (unit wiring) → every request
   * reads the wall clock.
   */
  historyAnchor?: Pick<IndexHistoryAnchorResolver, "anchorSecOf">;
}

/**
 * The index a request reads, the root its drift is checked at, and the view of
 * the tree it reads — started at resolve time so the git status runs beside
 * the search instead of after it.
 */
interface ResolvedExploreTarget {
  collectionName: string;
  /** The provider this collection's texts are embedded with — the one its guard just checked. */
  embeddings: EmbeddingProvider;
  /** INDEX root for the drift check; undefined → check by collection name */
  path?: string;
  workingTreeView?: Promise<WorkingTreeView>;
  /**
   * The request's ONE history clock, unix seconds — resolved here, once, and
   * threaded to the typed age filters, the filter-preset compiler and every
   * rerank. Undefined → the wall clock.
   */
  historyAnchorSec?: number;
}

/**
 * A search query's embedding on the read path, or why there is none. Only a
 * caller whose strategy can rank without it (hybrid's BM25 leg) ever gets
 * `denseUnavailable`; every other caller gets the provider's error.
 */
interface ExploreQueryEmbedding {
  target: ResolvedExploreTarget;
  /** The query text: the request's string, or its variants joined by the separator. */
  query: string;
  embedding?: number[];
  /** Two or more variants (bd tea-rags-mcp-2vuz), each with its vector unless `denseUnavailable`. */
  queryVariants?: ExploreQueryVariant[];
  denseUnavailable?: { reason: string };
}

/**
 * Every query embed of a search, and the model guard's canary on it, waits
 * for no provider recovery: the configured wait is sized for indexing, and a
 * read that sat it out blocked an agent for minutes per call.
 */
const READ_PATH_EMBED: EmbeddingCallOptions = { maxRecoveryWaitMs: READ_PATH_EMBEDDING_RECOVERY_WAIT_MS };

/**
 * What `ExploreOps#buildFilter` resolved: the merged Qdrant filter handed to
 * the strategy, plus the notice owed to the caller when a rerank preset's
 * DEFAULT filter is what narrowed the set.
 */
interface ResolvedExploreFilter {
  filter: Record<string, unknown> | undefined;
  presetFilterNotice?: PresetFilterNotice;
}

/**
 * Response-envelope work `executeExplore` performs after the strategy returns.
 * Everything here is decided by the CALLING operation, not by the strategy:
 * which tools may attest confidence, and which of them resolved a preset
 * default that the caller should be told about.
 */
interface ExploreFinalizeOptions {
  /**
   * Confidence reads score MAGNITUDE against the collection's similarity
   * scale, so only the operations whose score is a genuine similarity opt in.
   */
  attachConfidence?: boolean;
  presetFilterNotice?: PresetFilterNotice;
  /**
   * Caller's payload allow-list. Applied HERE rather than in each strategy:
   * narrowing the payload that leaves the API is finalize work, the same step
   * that strips internal fields, so one place serves every search tool
   * (bd tea-rags-mcp-l2lix).
   */
  fields?: readonly string[];
  /**
   * A search tool answers: `fields` absent → the search defaults
   * (`DEFAULT_SEARCH_FIELDS` / `DEFAULT_META_ONLY_FIELDS`, bd
   * tea-rags-mcp-q1g6s.16) instead of find_symbol's lean default.
   */
  searchTool?: boolean;
  migration?: boolean;
  migrationMetaOnly?: boolean;
  /** find_symbol `relativePath`: rows are outlines, kept under metaOnly (`PayloadProjectionMode.outline`). */
  outline?: boolean;
  /** The level a `taskId` filter matched (`PayloadProjectionMode.taskIdsLevel`); absent → no taskId filter. */
  taskIdsLevel?: "file" | "chunk";
  /**
   * Never rejects (`WorkingTreeOverlay#view` degrades instead); its marker rides
   * on the answer, with the floors the strategy's reads claimed on it (D8).
   */
  workingTreeView?: Promise<WorkingTreeView>;
}

export class ExploreOps {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly reranker: RerankerPort;
  private readonly registry: TrajectoryRegistry;
  private readonly collectionRegistry: RegistryLookup;
  private readonly statsCache?: StatsCache;
  private readonly payloadSignals: PayloadSignalDescriptor[];
  private readonly essentialKeys: string[];
  private readonly modelGuard?: EmbeddingModelGuardPort;
  private readonly collectionEmbeddings?: CollectionEmbeddingsResolver;
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;
  private readonly indexMetricsQuery?: IndexMetricsQuery;
  private readonly migrationCorpusQuery: MigrationCorpusQuery;
  private readonly recomputeService?: StatsRecomputeService;
  private readonly chunkResolver?: SymbolChunkResolver;
  private readonly visibilityResolver?: SymbolVisibilityResolver;
  private readonly containerAncestorResolver?: ContainerAncestorResolver;
  private readonly enrichmentHealthFrameForPath?: (path: string) => readonly string[];
  private readonly workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  private readonly historyAnchor?: Pick<IndexHistoryAnchorResolver, "anchorSecOf">;

  constructor(deps: ExploreOpsDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.collectionRegistry = deps.collectionRegistry;
    this.statsCache = deps.statsCache;
    this.payloadSignals = deps.payloadSignals;
    this.essentialKeys = deps.essentialKeys;
    this.modelGuard = deps.modelGuard;
    this.collectionEmbeddings = deps.collectionEmbeddings;
    this.chunkResolver = deps.chunkResolver;
    this.visibilityResolver = deps.visibilityResolver;
    this.containerAncestorResolver = deps.containerAncestorResolver;
    this.enrichmentHealthFrameForPath = deps.enrichmentHealthFrameForPath;
    this.workingTreeOverlay = deps.workingTreeOverlay;
    this.historyAnchor = deps.historyAnchor;
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
    this.migrationCorpusQuery = new MigrationCorpusQuery(deps.qdrant, foldRailsTableMigrations);
    if (deps.statsCache) {
      this.indexMetricsQuery = new IndexMetricsQuery(
        deps.qdrant,
        deps.statsCache,
        this.payloadSignals,
        mapMarkerToHealth,
        (sourcePath) => new NotIndexedError(sourcePath),
        deps.signalFloors,
      );
      this.recomputeService = new StatsRecomputeService(deps.qdrant, deps.statsCache);
    }
  }

  // ---------------------------------------------------------------------------
  // Public operations — one per App interface method
  // ---------------------------------------------------------------------------

  /**
   * `scope` is internal (not a request field): the caller's request-wide reads
   * ({@link ExploreRequestScope}) — passed by a caller that runs many searches
   * for one answer, so the index probe and the tree measurement run once.
   */
  async semanticSearch(request: SemanticSearchRequest, scope?: ExploreRequestScope): Promise<ExploreResponse> {
    return this.embedAndDispatch(
      request,
      this.vectorStrategy,
      { attachConfidence: true, denseLegOptional: false },
      scope,
    );
  }

  async hybridSearch(request: HybridSearchRequest): Promise<ExploreResponse> {
    // No confidence: RRF fusion scores are a function of rank, not similarity.
    // Sparse floor (bd tea-rags-mcp-xi2r9.4): touched files answer from the
    // tree's chunks, scored on the BM25 leg. The dense leg is optional: with the
    // embedding provider down the BM25 leg answers alone.
    return this.embedAndDispatch(request, this.hybridStrategy, { attachConfidence: false, denseLegOptional: true });
  }

  async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
    // Scroll + rerank: no query vector, so the guard checks the model name only.
    const { collectionName, workingTreeView, historyAnchorSec } = await this.resolveAndGuard(
      request.collection,
      request.path,
      request.project,
      { nameOnly: true },
    );
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "rank_chunks");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const { filter, presetFilterNotice } = this.buildFilter(request, level, "rank_chunks", historyAnchorSec);
    return this.executeExplore(
      this.scrollRankStrategy,
      withHistoryClock(buildRankChunksContext(request, collectionName, filter, level), historyAnchorSec),
      {
        presetFilterNotice,
        fields: request.fields,
        searchTool: true,
        ...taskIdsProjectionOf(request, level),
        workingTreeView,
      },
    );
  }

  async searchCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
    const { collectionName, workingTreeView, embeddings, historyAnchorSec } = await this.resolveAndGuard(
      request.collection,
      request.path,
      request.project,
      { failOnProviderOutage: true, ...READ_PATH_EMBED },
    );
    const { embedding } = await embeddings.embed(request.query, READ_PATH_EMBED);
    const level = resolveEffectiveLevel(undefined, request.rerank, this.reranker, "search_code");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const { filter, presetFilterNotice } = this.buildFilter(request, level, "search_code", historyAnchorSec);
    return this.executeExplore(
      this.vectorStrategy,
      withHistoryClock(buildSearchCodeContext(request, collectionName, embedding, filter), historyAnchorSec),
      { presetFilterNotice, workingTreeView },
    );
  }

  /**
   * `strategy` omitted → built here, after the collection is resolved, so its
   * code examples are embedded with that collection's provider.
   */
  async findSimilar(request: FindSimilarRequest, strategy?: SimilarSearchStrategy): Promise<ExploreResponse> {
    // Not failOnProviderOutage: a request by chunk ids embeds nothing and
    // answers with the provider down; one that embeds code fails fast on its
    // own embed (the strategy holds it to the same read budget).
    const target = await this.resolveAndGuard(request.collection, request.path, request.project, READ_PATH_EMBED);
    const { collectionName, workingTreeView, historyAnchorSec } = target;
    const similar = strategy ?? this.buildSimilarStrategy(request, target.embeddings);
    const level = resolveEffectiveLevel(request.level, request.rerank, this.reranker, "semantic_search");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    await this.ensureStats(collectionName);
    const { filter, presetFilterNotice } = this.buildFilter(request, level, "semantic_search", historyAnchorSec);
    // No confidence: the recommend score IS a similarity and separates
    // perfectly within this leg (measured AUC 1.000), but its query is CODE,
    // which sits far closer to a code corpus than prose does. The cut-points
    // are calibrated on prose queries, so applying them here labels every
    // find_similar response "high". Needs its own calibration corpus first.
    const ctx = withHistoryClock(buildFindSimilarContext(request, collectionName, filter, level), historyAnchorSec);
    return this.executeExplore(similar, ctx, {
      presetFilterNotice,
      fields: request.fields,
      searchTool: true,
      workingTreeView,
    });
  }

  async findSymbol(pastedRequest: FindSymbolRequest): Promise<ExploreResponse> {
    // An outline line pasted verbatim keeps its ` (visibility)` / ` L12-40`
    // suffix: the address is the id in front of it (bd tea-rags-mcp-9f0yn.1).
    const request: FindSymbolRequest = {
      ...pastedRequest,
      ...(pastedRequest.symbol !== undefined ? { symbol: outlineAddressOf(pastedRequest.symbol) } : {}),
      ...(pastedRequest.symbols ? { symbols: pastedRequest.symbols.map((symbol) => outlineAddressOf(symbol)) } : {}),
    };
    // Lookup by symbol: no query vector, so the guard checks the model name only.
    const { collectionName, workingTreeView, historyAnchorSec } = await this.resolveAndGuard(
      request.collection,
      request.path,
      request.project,
      { nameOnly: true },
    );
    if (request.symbol !== undefined && isMigrationCorpusAddress(request.symbol)) {
      return this.findMigrationSymbol(request, request.symbol, migrationCollectionName(collectionName));
    }
    const ctx = withHistoryClock(buildFindSymbolContext(request, collectionName), historyAnchorSec);
    if (request.symbols) return this.findSymbolBatch(request, request.symbols, ctx, workingTreeView);
    const strategy = this.buildFindSymbolStrategy(request);
    const response = await this.executeExplore(strategy, ctx, {
      fields: request.fields,
      outline: strategy instanceof FileOutlineStrategy,
      workingTreeView,
    });
    // Finalize: the per-request symbol strategy records a skipped OPTIONAL
    // codegraph hop (codegraph unavailable from this process) — attach it so the
    // caller learns why a collapsed symbol is missing (bd tea-rags-mcp-a43tr).
    const codegraphWarning = strategy instanceof SymbolSearchStrategy ? strategy.codegraphWarning : undefined;
    // A directory path is answered by its listing (N2), an unknown path by the
    // nearest indexed paths (N6 `unknownPath`).
    const directory = strategy instanceof FileOutlineStrategy ? strategy.directory : undefined;
    const empty =
      strategy instanceof FileOutlineStrategy
        ? strategy.emptyAnswer
        : response.results.length === 0 && request.symbol
          ? ((strategy instanceof SymbolSearchStrategy ? strategy.emptyAnswer : undefined) ??
            (await this.explainSymbolMiss(request, request.symbol, ctx, workingTreeView)))
          : undefined;
    return {
      ...response,
      ...(codegraphWarning ? { codegraphWarning } : {}),
      ...(directory ? { directory } : {}),
      ...(empty ? { empty } : {}),
    };
  }

  /** N6 `unknownSymbol`: why a single `symbol` answered nothing; a failed diagnosis leaves the answer unexplained. */
  private async explainSymbolMiss(
    request: FindSymbolRequest,
    symbol: string,
    ctx: ExploreContext,
    pendingView: Promise<WorkingTreeView | undefined> | undefined,
  ): Promise<EmptyAnswerExplanation | undefined> {
    try {
      const view = await pendingView;
      const explainer = new SymbolMissExplainer((candidate) => this.buildSymbolSearchStrategy(request, candidate));
      return await explainer.explain(symbol, view ? { ...ctx, workingTreeView: view } : ctx);
    } catch {
      return undefined;
    }
  }

  /**
   * find_symbol `symbols` (N1): every address through its own symbol strategy
   * on the SAME context — one working-tree view, so one marker carries the
   * floors all of them claimed. Rows carry the lean payload unless `fields` or
   * `rerank` asks for more; the request (and a separator swap) rides each row.
   * `table:` / `migration:` addresses are answered from the migration corpus
   * exactly as single mode answers them ({@link findMigrationBatch}) and merged
   * back in request order (bd tea-rags-mcp-7dcty.2).
   */
  private async findSymbolBatch(
    request: FindSymbolRequest,
    symbols: readonly string[],
    ctx: ExploreContext,
    pendingView: Promise<WorkingTreeView | undefined> | undefined,
  ): Promise<ExploreResponse> {
    const migrationAddresses = symbols.filter(isMigrationCorpusAddress);
    if (migrationAddresses.length === 0) return this.findCodeSymbolBatch(request, symbols, ctx, pendingView);
    const codeSymbols = symbols.filter((symbol) => !isMigrationCorpusAddress(symbol));
    const [code, migration] = await Promise.all([
      this.findCodeSymbolBatch(request, codeSymbols, ctx, pendingView),
      this.findMigrationBatch(request, migrationAddresses, migrationCollectionName(ctx.collectionName)),
    ]);
    return {
      ...code,
      results: inRequestOrder(symbols, [...code.results, ...migration.results], (row) => row.payload?.request),
      missing: inRequestOrder(symbols, [...(code.missing ?? []), ...migration.missing], (miss) => miss.request),
    };
  }

  /**
   * The migration-corpus half of a `symbols` batch: each address through
   * {@link findMigrationSymbol}, its single-mode answer reshaped into batch
   * rows. A `migration:<id>` row is the operation chunk (locator + content,
   * locator only under metaOnly). A `table:<name>` row carries the folded
   * state under `payload.tableState` (`payload.table` = the table name, the
   * string a migration chunk row carries there) — the `RailsTableState` single mode puts
   * on `ExploreResponse.table`, keyed by `request` with `id` / `symbolId` =
   * the address — because a batch has one `table` slot for N tables. A single
   * mode `empty` becomes a `missing` entry with its message; the reason code
   * (`notBuilt` / `noTableOperations` / `unknownSymbol`) is read from the
   * message, as a batch path miss reads `noSymbols` / `ignoredPath`.
   */
  private async findMigrationBatch(
    request: FindSymbolRequest,
    addresses: readonly string[],
    migrationCollection: string,
  ): Promise<{ results: ExploreResponse["results"]; missing: SymbolBatchMiss[] }> {
    const answers = await Promise.all(
      addresses.map(async (address) => ({
        address,
        answer: await this.findMigrationSymbol(request, address, migrationCollection),
      })),
    );
    return {
      results: answers.flatMap(({ address, answer }) => [
        ...answer.results.map((row) => ({ ...row, payload: { request: address, ...row.payload } })),
        ...(answer.table
          ? [
              {
                id: address,
                score: 1,
                payload: { request: address, symbolId: address, table: answer.table.table, tableState: answer.table },
              },
            ]
          : []),
      ]),
      missing: answers.flatMap(({ address, answer }) =>
        answer.empty ? [{ request: address, message: answer.empty.message }] : [],
      ),
    };
  }

  private async findCodeSymbolBatch(
    request: FindSymbolRequest,
    symbols: readonly string[],
    ctx: ExploreContext,
    pendingView: Promise<WorkingTreeView | undefined> | undefined,
  ): Promise<ExploreResponse> {
    await this.ensureStats(ctx.collectionName);
    const workingTreeView = await pendingView;
    const drill = new SymbolBatchDrill(
      (symbol) => this.buildSymbolSearchStrategy(request, symbol),
      (relativePath) => this.buildFileOutlineStrategy(relativePath, request.language),
    );
    const answer = await drill.execute(symbols, workingTreeView ? { ...ctx, workingTreeView } : ctx);
    const fields = request.fields ?? (request.rerank ? undefined : BATCH_LEAN_FIELDS);
    const projection = projectSearchResultPayloads(
      answer.rows.map(({ result }) => ({
        id: result.id ?? "",
        score: result.score,
        payload: result.payload ? stripInternalFields(result.payload) : result.payload,
        rankingOverlay: result.rankingOverlay,
        ...(result.treeState ? { treeState: result.treeState } : {}),
      })),
      fields,
      undefined,
      // Internal batch defaults must not warn about optional absent fields;
      // mandatory source-locator warnings still pass through without `fields`.
      request.fields !== undefined,
    );
    // metaOnly's lean default drops a symbol row's body, but a file-path row's
    // `content` IS the outline metaOnly asks for — it stays, as in relativePath
    // mode (bd tea-rags-mcp-y3trx).
    const leanMetaOnly = request.metaOnly === true && !request.fields && !request.rerank;
    const results = projection.results.map((row, i) => {
      const { request: address, resolvedAs, fileOutline, sameChunkAs } = answer.rows[i];
      const { content: _body, ...bodyless } = row.payload ?? {};
      const payload = leanMetaOnly && !fileOutline ? bodyless : row.payload;
      const marks = { ...(resolvedAs ? { resolvedAs } : {}), ...(sameChunkAs ? { sameChunkAs } : {}) };
      return { ...row, payload: { request: address, ...marks, ...payload } };
    });
    const workingTree = workingTreeView ? finalizeWorkingTreeMarker(workingTreeView) : undefined;
    return {
      results,
      missing: answer.missing,
      ...(projection.fieldsWarning ? { fieldsWarning: projection.fieldsWarning } : {}),
      ...(answer.codegraphWarning ? { codegraphWarning: answer.codegraphWarning } : {}),
      ...(answer.batchNotice ? { batchNotice: answer.batchNotice } : {}),
      ...(workingTree ? { workingTree } : {}),
    };
  }

  /**
   * `collection` is an already-resolved index a caller addressed explicitly
   * (bd tea-rags-mcp-2kplu): it wins over the path, as it does in every
   * resolver — a worktree path hashes to a collection that does not exist.
   */
  async getIndexMetrics(path: string, collection?: string, options?: IndexMetricsReadOptions): Promise<IndexMetrics> {
    if (!this.indexMetricsQuery) throw new NotIndexedError(path);
    // Same rule the search legs above resolve by, handed the SAME spelling:
    // a project that moved keeps the collection its registry entry recorded, so
    // the metrics a reader asks for by path are the metrics of the index they
    // are searching (bd tea-rags-mcp-dxa9w).
    //
    // The raw path goes over verbatim — canonicalizing here would defeat the
    // owner's own fast lookup, which tries the resolved spelling first exactly
    // so an entry a pre-canonicalization writer recorded stays findable. A
    // caller that pre-canonicalizes turns that miss into a hash, and the same
    // project then answers with one collection through a search and another
    // through this call.
    const workingTree = resolveWorkingTree(this.collectionRegistry, { collection, path });
    const { collectionName } = workingTree.baseIndex;
    // Every read answer carries the marker (bd tea-rags-mcp-xi2r9, live probe
    // P2-4): the metrics describe the INDEX, and the marker says how far the
    // caller's tree is from it. Measured beside the metrics read, never after.
    const workingTreeView =
      options?.workingTreeMarker === false ? undefined : this.workingTreeOverlay?.view(workingTree, undefined);
    await this.ensureStats(collectionName);
    const metrics = await this.indexMetricsQuery.run(
      collectionName,
      path,
      this.enrichmentHealthFrameForPath?.(path) ?? [],
    );
    return workingTreeView ? { ...metrics, workingTree: (await workingTreeView).marker } : metrics;
  }

  /**
   * The base index `path` is read against when it is a working tree of a
   * registered index other than its own checkout (live D10) — a linked
   * worktree, or a subdirectory project of one — with the tree's marker.
   * Undefined for an index's own checkout, for a path no registered index
   * covers, and for one the resolver refuses: those keep their own answer.
   */
  async workingTreeIndexOf(path: string): Promise<WorkingTreeIndexTarget | undefined> {
    let workingTree: WorkingTree;
    try {
      workingTree = resolveWorkingTree(this.collectionRegistry, { path });
    } catch {
      return undefined;
    }
    const { root: indexPath, collectionName } = workingTree.baseIndex;
    if (!indexPath || !workingTree.root || resolve(workingTree.root) === resolve(indexPath)) return undefined;
    if (!this.collectionRegistry.get(collectionName)) return undefined;
    const view = await this.workingTreeOverlay?.view(workingTree, undefined);
    return view ? { indexPath, workingTree: view.marker } : { indexPath };
  }

  /**
   * Factory for the per-request findSimilar strategy. `embeddings` defaults to
   * the process provider; `findSimilar` passes the resolved collection's.
   */
  buildSimilarStrategy(
    request: FindSimilarRequest,
    embeddings: EmbeddingProvider = this.embeddings,
  ): SimilarSearchStrategy {
    return new SimilarSearchStrategy(this.qdrant, this.reranker, this.payloadSignals, this.essentialKeys, embeddings, {
      positiveIds: request.positiveIds,
      positiveCode: request.positiveCode,
      negativeIds: request.negativeIds,
      negativeCode: request.negativeCode,
      strategy: request.strategy ?? "best_score",
      fileExtensions: request.fileExtensions,
    });
  }

  // ---------------------------------------------------------------------------
  // Private pipeline helpers
  // ---------------------------------------------------------------------------

  /**
   * Unified pipeline: ensureStats → strategy.execute → shape. No drift warning:
   * get_index_status / index_codebase / prime report drift (bd tea-rags-mcp-68jud).
   *
   * `attachConfidence` is opt-in per operation rather than global. Confidence
   * reads score MAGNITUDE against the collection's similarity scale, so it only
   * means something where the score is a genuine similarity: semantic_search
   * and find_similar. hybrid_search fuses with RRF and emits rank-derived
   * scores; rank_chunks scrolls a filtered set; find_symbol is an exact lookup.
   * On those three the number would attest nothing.
   */
  private async executeExplore(
    strategy: BaseExploreStrategy,
    ctx: ExploreContext,
    finalize: ExploreFinalizeOptions = {},
  ): Promise<ExploreResponse> {
    if (!finalize.migration) await this.ensureStats(ctx.collectionName);
    const workingTreeView = await finalize.workingTreeView;
    const candidates = await strategy.execute(workingTreeView ? { ...ctx, workingTreeView } : ctx);
    const results = finalize.migration
      ? candidates
      : candidates.filter((result) => {
          const path = result.payload?.relativePath;
          return typeof path !== "string" || !/(?:^|\/)db\/migrate\//.test(path.replaceAll("\\", "/"));
        });
    const confidence = finalize.attachConfidence
      ? computeSearchConfidence(toConfidenceInput(results), this.reranker.getCollectionStats()?.scoreBackground)
      : undefined;
    const projection = projectSearchResultPayloads(
      results.map((r) => {
        const payload = r.payload ? stripInternalFields(r.payload) : r.payload;
        if (payload && finalize.migrationMetaOnly) delete payload.content;
        return {
          id: r.id ?? "",
          score: r.score,
          payload,
          rankingOverlay: r.rankingOverlay,
          ...(r.treeState ? { treeState: r.treeState } : {}),
        };
      }),
      finalize.fields,
      // N4: `fields` absent → the call mode's default projection; the LAST
      // payload step, after every reader of the full payload ran.
      {
        metaOnly: ctx.metaOnly === true || finalize.migrationMetaOnly === true,
        reranked: ctx.rerank !== undefined && ctx.rerank !== "relevance",
        searchTool: finalize.searchTool === true,
        migration: finalize.migration === true,
        outline: finalize.outline === true,
        ...(finalize.taskIdsLevel ? { taskIdsLevel: finalize.taskIdsLevel } : {}),
      },
    );
    const workingTree = workingTreeView ? finalizeWorkingTreeMarker(workingTreeView) : undefined;
    return {
      results: projection.results,
      ...(ctx.level ? { level: ctx.level } : {}),
      ...(confidence ? { confidence } : {}),
      ...(finalize.presetFilterNotice ? { presetFilterNotice: finalize.presetFilterNotice } : {}),
      ...(projection.fieldsWarning ? { fieldsWarning: projection.fieldsWarning } : {}),
      // Read AFTER the strategy ran: reading the delta rows is what records
      // `unparsed` on the marker.
      ...(workingTree ? { workingTree } : {}),
    };
  }

  /**
   * Shared flow for semantic + hybrid: embed → resolveDocRerank → level →
   * filter → execute. `attachConfidence` differs between the two: the dense
   * score is a similarity, the RRF-fused hybrid score is a rank.
   * `denseLegOptional`: the strategy ranks without the query vector when the
   * provider is down, and the answer carries `denseUnavailable`.
   */
  private async embedAndDispatch(
    request: SemanticSearchRequest | HybridSearchRequest,
    strategy: BaseExploreStrategy,
    { attachConfidence, denseLegOptional }: { attachConfidence: boolean; denseLegOptional: boolean },
    scope?: ExploreRequestScope,
  ): Promise<ExploreResponse> {
    let migrationMarker: { collection: string; revision: unknown } | undefined;
    if (request.scope === "migrations") {
      const workingTree = await resolveIndexedWorkingTree(this.collectionRegistry, request, async (name) =>
        this.qdrant.collectionExists(name),
      );
      const migrationCollection = migrationCollectionName(workingTree.baseIndex.collectionName);
      if (!(await this.qdrant.collectionExists(migrationCollection))) {
        return { results: [] };
      }
      const marker = await this.qdrant.getPoint?.(migrationCollection, INDEXING_METADATA_ID);
      if (marker === null || (marker && marker.payload?.indexingComplete !== true)) {
        throw new Error("Migration corpus update is incomplete; retry indexing before searching migrations");
      }
      if (marker) migrationMarker = { collection: migrationCollection, revision: marker.payload?.migrationRevision };
    }
    const { target, query, embedding, queryVariants, denseUnavailable } = await this.embedQuery(
      request,
      denseLegOptional,
      scope,
    );
    const { collectionName, historyAnchorSec } = target;
    // Fused variants: RRF scores are ranks (no confidence), and no floor (one query) ranks the tree's rows.
    const workingTreeView = queryVariants
      ? target.workingTreeView?.then(withoutWorkingTreeFloors)
      : target.workingTreeView;
    const rerank =
      request.scope === "migrations"
        ? undefined
        : resolveDocRerank(request.rerank, request.documentation, request.language);
    const level = resolveEffectiveLevel(request.level, rerank, this.reranker, "semantic_search");
    // Load collection stats BEFORE buildFilter so filter-preset adaptive
    // percentiles resolve from real Stats on the first (cold) query, not
    // fallbacks. Guarded + idempotent — the call in executeExplore is a no-op.
    if (request.scope !== "migrations") await this.ensureStats(collectionName);
    const filterRequest =
      request.scope === "migrations" && request.filter === undefined ? { ...request, filter: {} } : request;
    const { filter, presetFilterNotice } = this.buildFilter(filterRequest, level, "semantic_search", historyAnchorSec);
    const vectorCtx = buildVectorSearchContext(request, query, collectionName, embedding, filter, rerank, level);
    if (request.scope === "migrations" && request.metaOnly) vectorCtx.metaOnly = false;
    const ctx = withHistoryClock(queryVariants ? { ...vectorCtx, queryVariants } : vectorCtx, historyAnchorSec);
    const response = await this.executeExplore(strategy, denseUnavailable ? { ...ctx, denseUnavailable } : ctx, {
      attachConfidence: attachConfidence && !queryVariants && request.scope !== "migrations",
      presetFilterNotice,
      fields: request.fields,
      searchTool: true,
      ...taskIdsProjectionOf(request, level),
      migration: request.scope === "migrations",
      migrationMetaOnly: request.scope === "migrations" && request.metaOnly === true,
      workingTreeView,
    });
    if (migrationMarker) {
      const marker = await this.qdrant.getPoint(migrationMarker.collection, INDEXING_METADATA_ID);
      if (marker?.payload?.indexingComplete !== true) {
        throw new Error("Migration corpus update is incomplete; retry indexing before searching migrations");
      }
      if (marker.payload.migrationRevision !== migrationMarker.revision) {
        throw new Error("Migration corpus changed during the search; retry the query");
      }
    }
    // N6: the diagnosis counts run ONLY on an empty answer, and a failed
    // count leaves the explanation out instead of failing the search.
    const empty =
      response.results.length === 0
        ? await this.explainEmpty(collectionName, request, level, presetFilterNotice).catch(() => undefined)
        : undefined;
    const explained = empty ? { ...response, empty } : response;
    return denseUnavailable ? { ...explained, denseUnavailable } : explained;
  }

  /**
   * Why an empty semantic / hybrid answer is empty (agent turn economy N6):
   * which of its narrowing params the index answers to. Counts the INDEX only;
   * a typed param counts as narrowing when the registry compiles it to a
   * condition (`testFile: "include"` compiles to none).
   */
  private async explainEmpty(
    collectionName: string,
    request: SemanticSearchRequest | HybridSearchRequest,
    level: SignalLevel | undefined,
    presetFilterNotice: PresetFilterNotice | undefined,
  ): Promise<EmptyAnswerExplanation> {
    const params = request as unknown as Record<string, unknown>;
    const typedParams = this.registry
      .getAllFilters()
      .map((descriptor) => descriptor.param)
      .filter((param) => param !== "pathPattern" && this.registry.buildFilter({ [param]: params[param] }, level));
    const ownFilter = request.filter !== undefined && Object.keys(request.filter).length > 0;
    return explainEmptySearch(
      {
        count: async (filter) => this.qdrant.countPoints(collectionName, filter),
        samplePaths: async (filter, limit) =>
          (await this.qdrant.scrollFiltered(collectionName, filter, limit, limit, ["relativePath"])).map((point) =>
            typeof point.payload.relativePath === "string" ? point.payload.relativePath : "",
          ),
      },
      {
        pathPattern: request.pathPattern,
        pathFilter: (pathPattern) =>
          this.registry.buildFilter({ pathPattern }, level) as Record<string, unknown> | undefined,
        narrowingParams: ownFilter ? ["filter", ...typedParams] : typedParams,
        presetFilterNotice,
      },
    );
  }

  /**
   * Resolve the target, guard the model and embed the query — the canary and
   * the query embed both held to the read-path recovery budget, so a down
   * provider fails the call at once instead of after its indexing-sized wait.
   *
   * An OUTAGE (`isEmbeddingProviderUnavailable`, from the canary or the query
   * embed) is answered, not thrown, when `denseLegOptional`: no vector of this
   * request reaches Qdrant then, so only the model NAME can make the answer
   * wrong, and it is checked by name alone. Any other error propagates.
   */
  private async embedQuery(
    request: SemanticSearchRequest | HybridSearchRequest,
    denseLegOptional: boolean,
    scope?: ExploreRequestScope,
  ): Promise<ExploreQueryEmbedding> {
    const variants = splitQueryVariants(request.query);
    const query = variants.join(` ${QUERY_VARIANT_SEPARATOR} `);
    const { modelGuard, ...target } = await this.resolveTarget(
      request.collection,
      request.path,
      request.project,
      true,
      scope,
      request.scope === "migrations",
    );
    try {
      await modelGuard?.ensureMatch(target.collectionName, { failOnProviderOutage: true, ...READ_PATH_EMBED });
      if (variants.length === 1) {
        const { embedding } = await target.embeddings.embed(query, READ_PATH_EMBED);
        return { target, query, embedding };
      }
      // Every variant in ONE provider call.
      const embedded = await target.embeddings.embedBatch(variants, READ_PATH_EMBED);
      const queryVariants = variants.map((text, i) => ({ query: text, embedding: embedded[i]?.embedding }));
      return { target, query, embedding: queryVariants[0]?.embedding, queryVariants };
    } catch (error) {
      if (!denseLegOptional || !isEmbeddingProviderUnavailable(error)) throw error;
      await modelGuard?.ensureMatch(target.collectionName, { nameOnly: true });
      const queryVariants = variants.length > 1 ? variants.map((text) => ({ query: text })) : undefined;
      return {
        target,
        query,
        denseUnavailable: { reason: error.message },
        ...(queryVariants ? { queryVariants } : {}),
      };
    }
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
   *
   * A preset DEFAULT that excludes what the caller's typed params explicitly
   * select (tests, docs, a chunk type, an explicit "include", a documentation
   * language) is dropped — see `presetDefaultExcludesCallerScope`. An explicit
   * `filter` is never touched.
   *
   * A default that SURVIVES that check narrowed the candidate set without the
   * caller asking for it, so the resolution also carries a
   * {@link PresetFilterNotice} naming it. The notice is built from what this
   * method already resolved — no extra query — and is the only place that can
   * tell "the caller's filter" from "a default they never wrote"
   * (bd tea-rags-mcp-0qfpi).
   */
  private buildFilter(
    request: Record<string, unknown> | { filter?: Record<string, unknown> },
    level: SignalLevel | undefined,
    tool: "semantic_search" | "search_code" | "rank_chunks" = "semantic_search",
    historyAnchorSec?: number,
  ): ResolvedExploreFilter {
    const req = request as Record<string, unknown> & { filter?: FilterSpec; rerank?: unknown };
    const presetName = typeof req.rerank === "string" ? req.rerank : undefined;
    const presetDefault = presetName ? this.reranker.getFullPreset(presetName, tool)?.filter : undefined;
    const stats = this.reranker.getCollectionStats();
    let resolved = resolveFilterSpec(
      req.filter,
      presetDefault,
      stats,
      level ?? "chunk",
      this.registry,
      historyAnchorSec,
    );
    const appliesDefault = req.filter === undefined && presetDefault !== undefined;
    if (appliesDefault && presetDefaultExcludesCallerScope(resolved, this.registry.buildFilter(req, level), req)) {
      resolved = undefined;
    }
    const presetFilterNotice =
      appliesDefault && resolved !== undefined && presetName !== undefined
        ? buildPresetFilterNotice(presetName, presetDefault, resolved)
        : undefined;
    // A wall-clock request passes exactly what it passed before the clock existed.
    const filter =
      historyAnchorSec === undefined
        ? this.registry.buildMergedFilter(req, resolved, level)
        : this.registry.buildMergedFilter(req, resolved, level, historyAnchorSec);
    return { filter, presetFilterNotice };
  }

  /**
   * `table:<name>` / `migration:<id>` — answered from the migration corpus
   * (bd tea-rags-mcp-nplgm): the table's folded current state, or one
   * migration operation chunk (the drill target of the state's provenance).
   */
  private async findMigrationSymbol(
    request: FindSymbolRequest,
    symbol: string,
    migrationCollection: string,
  ): Promise<ExploreResponse> {
    if (symbol.startsWith(RAILS_TABLE_ID_PREFIX)) {
      const table = symbol.slice(RAILS_TABLE_ID_PREFIX.length);
      const answer = await this.migrationCorpusQuery.tableState(migrationCollection, table);
      if (answer.kind === "state") return { results: [], table: answer.state };
      const empty: EmptyAnswerExplanation =
        answer.kind === "noCorpus"
          ? {
              reason: "notBuilt",
              message: "No migration corpus is indexed for this project — table:<name> needs an indexed db/migrate.",
            }
          : {
              reason: "noTableOperations",
              message: `No change/up migration operation names table ${table}: absent from db/migrate, or created only by raw SQL or a computed name.`,
            };
      return { results: [], empty };
    }
    const points = await this.migrationCorpusQuery.operation(migrationCollection, symbol);
    if (points.length === 0) {
      return {
        results: [],
        empty: { reason: "unknownSymbol", message: `${symbol} is not a migration chunk id in the migration corpus.` },
      };
    }
    return {
      results: points.map(({ id, payload }) => {
        const { content, ...locator } = payload;
        return { id, score: 1, payload: request.metaOnly ? locator : { ...locator, content } };
      }),
    };
  }

  private buildFindSymbolStrategy(request: FindSymbolRequest): BaseExploreStrategy {
    if (request.relativePath) return this.buildFileOutlineStrategy(request.relativePath, request.language);
    return this.buildSymbolSearchStrategy(request, request.symbol as string);
  }

  /** The path-mode strategy for one file or directory — single `relativePath` and every batch path entry alike. */
  private buildFileOutlineStrategy(relativePath: string, language: string | undefined): FileOutlineStrategy {
    return new FileOutlineStrategy(
      this.qdrant,
      this.reranker,
      this.payloadSignals,
      this.essentialKeys,
      { relativePath, language },
      this.visibilityResolver,
    );
  }

  /** The symbol-mode strategy for one address — single `symbol` and every batch address alike. */
  private buildSymbolSearchStrategy(request: FindSymbolRequest, symbol: string): SymbolSearchStrategy {
    return new SymbolSearchStrategy(
      this.qdrant,
      this.reranker,
      this.payloadSignals,
      this.essentialKeys,
      this.registry,
      { symbol, language: request.language, pathPattern: request.pathPattern },
      this.chunkResolver,
      this.visibilityResolver,
      this.containerAncestorResolver,
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
    guardOptions?: EmbeddingModelGuardCallOptions,
  ): Promise<ResolvedExploreTarget> {
    const { modelGuard, ...resolved } = await this.resolveTarget(collection, path, project, !guardOptions?.nameOnly);
    await modelGuard?.ensureMatch(resolved.collectionName, guardOptions);
    return resolved;
  }

  /** The index and tree a request reads, without the model guard. */
  private async resolveTarget(
    collection: string | undefined,
    path: string | undefined,
    project: string | undefined,
    embeds: boolean,
    scope?: ExploreRequestScope,
    migrations = false,
  ): Promise<ResolvedExploreTarget & { modelGuard?: EmbeddingModelGuardPort }> {
    // The one existence seam every read tool resolves through (live round-3 D3):
    // a missing index is refused before the overlay measures the tree.
    const workingTree = await resolveIndexedWorkingTree(
      this.collectionRegistry,
      { collection, project, path },
      async (name) =>
        scope
          ? scope.collectionExists(name, async (probed) => this.qdrant.collectionExists(probed))
          : this.qdrant.collectionExists(name),
    );
    const resolved = migrations
      ? {
          collectionName: migrationCollectionName(workingTree.baseIndex.collectionName),
          path: workingTree.baseIndex.root,
        }
      : this.targetOf(workingTree, path, project, scope);
    // The collection's own provider and guard (bd tea-rags-mcp-b91f5): the
    // marker is held to the model that will embed for it, never to this
    // process's default model. The index's history clock is read beside it.
    const [binding, historyAnchorSec] = await Promise.all([
      this.embeddingBindingOf(resolved.collectionName, embeds),
      this.historyAnchor?.anchorSecOf(resolved.collectionName),
    ]);
    return {
      ...resolved,
      embeddings: binding.embeddings,
      modelGuard: binding.modelGuard,
      ...(historyAnchorSec !== undefined ? { historyAnchorSec } : {}),
    };
  }

  /** The collection's embedding binding; the process provider and guard without a resolver. */
  private async embeddingBindingOf(
    collectionName: string,
    embeds: boolean,
  ): Promise<Pick<CollectionEmbeddingBinding, "embeddings"> & { modelGuard?: EmbeddingModelGuardPort }> {
    if (this.collectionEmbeddings) return this.collectionEmbeddings.forCollection(collectionName, { embeds });
    return { embeddings: this.embeddings, modelGuard: this.modelGuard };
  }

  /**
   * One addressing rule (bd tea-rags-mcp-xi2r9): the request names a tree and
   * the index it reads that tree against. Drift is a property of the INDEX, so
   * it is checked at the index root — never at the tree, which the reporter
   * would hash to a collection nobody indexed. A request that named only its
   * collection keeps the by-name check.
   */
  private targetOf(
    workingTree: WorkingTree,
    path?: string,
    project?: string,
    scope?: ExploreRequestScope,
  ): Omit<ResolvedExploreTarget, "embeddings"> {
    const { collectionName, root } = workingTree.baseIndex;
    const addressedByLocation = path !== undefined || project !== undefined;
    return {
      collectionName,
      path: addressedByLocation ? root : undefined,
      workingTreeView: scope
        ? this.workingTreeOverlay?.view(workingTree, project, scope.workingTree)
        : this.workingTreeOverlay?.view(workingTree, project),
    };
  }

  private async ensureStats(collectionName: string): Promise<void> {
    if (!this.statsCache) return;
    // Ask for THIS collection at the revision on disk right now. A guard that
    // only asked "are any stats loaded" pinned the process to the first
    // collection it served and could not see a recompute another process wrote
    // (bd tea-rags-mcp-yntsd). The probe is a stat, not a read.
    const revision = this.statsCache.lastWrittenAt(collectionName);
    if (this.reranker.hasCollectionStatsFor(collectionName, revision)) return;
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
        revision,
      });
    } catch {
      // Stats loading failure must not prevent search.
    }
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

/** A test chunk type selected by a typed filter also selects `isTest: true`. */
function isTestChunkType(value: unknown): boolean {
  return typeof value === "string" && TEST_CHUNK_TYPES.has(value);
}

/**
 * Does a compiled preset DEFAULT filter exclude the population the caller's
 * typed params explicitly select? (tea-rags-mcp-9mwny)
 *
 * Preset defaults are hygiene for UNSCOPED searches (`production`: no tests,
 * docs or block chunks; `coreLogic`: function/class only). A caller who
 * scopes to tests / docs / a chunk type has made the choice the default was
 * guessing at; AND-ing both returned 0 results by construction. Rule: each
 * exact `must` selection of the typed filter (`testFile: "only"` →
 * isTest=true, `documentation: "only"` → isDocumentation=true, `chunkType` →
 * chunkType=X, a test chunk type also implying isTest=true) is checked
 * against the default — a `must_not` on the same key+value, or a `must` on the
 * same key that admits a different value, means the default excludes the
 * caller's scope, and the WHOLE default is dropped (the same replace, never
 * compose, rule an explicit `filter` already follows). Selections the default
 * does not touch (chunkType "function" under `production`) keep it.
 *
 * Some scope choices compile to no condition the typed filter can show, so
 * they are read from the caller's params: `testFile: "include"` /
 * `documentation: "include"` ("all files" — compiles to nothing) admit
 * isTest=true / isDocumentation=true, and a documentation `language`
 * (markdown) selects isDocumentation=true through a condition on another key.
 * Only a param the caller actually passed counts — the search schemas give
 * `testFile` / `documentation` no default, so an omitted one is absent here.
 */
export function presetDefaultExcludesCallerScope(
  compiledDefault: Record<string, unknown> | undefined,
  typedFilter: QdrantFilter | undefined,
  callerParams: Record<string, unknown> = {},
): boolean {
  if (!compiledDefault) return false;
  const selections = new Map<string, unknown>();
  for (const condition of typedFilter?.must ?? []) {
    const exact = exactMatchCondition(condition);
    if (exact) selections.set(exact.key, exact.value);
  }
  if (isTestChunkType(selections.get("chunkType"))) selections.set("isTest", true);
  if (callerParams.testFile === "include") selections.set("isTest", true);
  if (callerParams.documentation === "include") selections.set("isDocumentation", true);
  if (typeof callerParams.language === "string" && DOCUMENTATION_LANGUAGES.has(callerParams.language)) {
    selections.set("isDocumentation", true);
  }
  if (selections.size === 0) return false;

  const defaultMust = (compiledDefault.must ?? []) as unknown[];
  const defaultMustNot = (compiledDefault.must_not ?? []) as unknown[];
  for (const [key, value] of selections) {
    if (defaultMustNot.some((c) => exactMatchCondition(c)?.key === key && exactMatchCondition(c)?.value === value)) {
      return true;
    }
    if (defaultMust.some((c) => admitsOnlyOtherValues(c, key, value))) return true;
  }
  return false;
}

/**
 * Describe the rerank preset DEFAULT that narrowed this query, so an empty or
 * thin answer is attributable from the response alone (bd tea-rags-mcp-0qfpi).
 *
 * `presetDefault` is the DECLARED spec — a `{presets}` reference carries the
 * filter-preset names, a raw Qdrant filter carries none. `compiledDefault` is
 * that spec after compilation, and it is where the payload keys come from:
 * a `{presets}` name says nothing about what it constrains, and an adaptive
 * percentile condition only becomes a key after the compiler has run.
 *
 * No count rides along. The search issues ONE Qdrant query, so the unfiltered
 * candidate total is not at hand and producing it would mean a second
 * round-trip on every search — a worse defect than a missing integer.
 */
export function buildPresetFilterNotice(
  presetName: string,
  presetDefault: FilterSpec,
  compiledDefault: Record<string, unknown> | undefined,
): PresetFilterNotice | undefined {
  const keys = collectFilterKeys(compiledDefault);
  if (keys.length === 0) return undefined;
  const source = isPresetsSpec(presetDefault)
    ? presetDefault.presets
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .join("+")
    : "";
  return {
    preset: presetName,
    by: `${source.length > 0 ? source : "raw filter"} (${keys.join(", ")})`,
    clearWith: "filter: {}",
  };
}

/**
 * Payload keys a compiled Qdrant filter constrains, de-duplicated, in the
 * order the compiler emitted them. Descends into the nested `must:[{should}]`
 * group the filter-preset compiler builds for at-least-one conditions.
 */
function collectFilterKeys(filter: Record<string, unknown> | undefined): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const group = node as { key?: unknown; must?: unknown; must_not?: unknown; should?: unknown };
    if (typeof group.key === "string" && !seen.has(group.key)) {
      seen.add(group.key);
      keys.push(group.key);
    }
    visit(group.must);
    visit(group.must_not);
    visit(group.should);
  };
  visit(filter);
  return keys;
}

function exactMatchCondition(condition: unknown): { key: string; value: unknown } | undefined {
  const c = condition as { key?: unknown; match?: { value?: unknown } };
  if (typeof c?.key !== "string" || !c.match || !("value" in c.match)) return undefined;
  return { key: c.key, value: c.match.value };
}

/** A `must` leaf on `key` that cannot match `value` (exact value or any-of list). */
function admitsOnlyOtherValues(condition: unknown, key: string, value: unknown): boolean {
  const c = condition as { key?: unknown; match?: { value?: unknown; any?: unknown[] } };
  if (c?.key !== key || !c.match) return false;
  if ("value" in c.match) return c.match.value !== value;
  if (Array.isArray(c.match.any)) return !c.match.any.includes(value);
  return false;
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
 * `nowSec` is the request's history clock (bd tea-rags-mcp-zwu7m) every
 * age threshold compiles against; undefined → the wall clock.
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
  nowSec?: number,
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
      // `nowSec` undefined → the compiler's wall-clock default.
      merged = mergeQdrantFilters(merged, compileFilterPreset(def, stats, level, nowSec));
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
  reranker: RerankerPort,
  tool: "semantic_search" | "search_code" | "rank_chunks",
): SignalLevel | undefined {
  if (userLevel) return userLevel;
  if (typeof rerank === "string") {
    const preset = reranker.getFullPreset(rerank, tool);
    return preset?.signalLevel;
  }
  return undefined;
}

/**
 * The context carrying the request's history clock (bd tea-rags-mcp-zwu7m);
 * a wall-clock request keeps the context it had before the clock existed.
 */
function withHistoryClock(ctx: ExploreContext, historyAnchorSec: number | undefined): ExploreContext {
  return historyAnchorSec === undefined ? ctx : { ...ctx, historyAnchorSec };
}

function buildVectorSearchContext(
  request: SemanticSearchRequest | HybridSearchRequest,
  query: string,
  collectionName: string,
  embedding: number[] | undefined,
  filter: Record<string, unknown> | undefined,
  rerank: SemanticSearchRequest["rerank"],
  level: SignalLevel | undefined,
): ExploreContext {
  return {
    collectionName,
    query,
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

/**
 * A `taskId` search keeps the matched `taskIds` array in its default
 * projection (bd tea-rags-mcp-d9w4o). The level is the one the filter compiled
 * at: the request's effective level, else the taskId filter's own default (file).
 */
function taskIdsProjectionOf(
  request: { taskId?: string },
  level: "chunk" | "file" | undefined,
): { taskIdsLevel?: "file" | "chunk" } {
  return request.taskId ? { taskIdsLevel: level ?? "file" } : {};
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

/**
 * The marker an answer carries: the view's, with exactly the floors this
 * request's reads claimed on it (live D8) — `"chunks"` / `"sparse"` when the
 * strategy put delta rows into its candidates (`claimWorkingTreeFloors`),
 * `"codegraph"` when those rows or a codegraph lookup read the tree graph
 * (WTO-7). A clean tree, a degraded view, a view without a chunk layer, and a
 * strategy that only read delta content claim nothing. A copy: the answer must
 * not alias the per-request marker.
 */
function finalizeWorkingTreeMarker(view: WorkingTreeView): WorkingTreeMarker {
  return { ...view.marker, floors: [...view.marker.floors] };
}

/**
 * The payload a find_symbol batch row carries unless `fields` or `rerank` asks
 * for more (N1). `kind` tells a path entry's full text (`file`) from its
 * outline (q1g6s.4); symbol rows carry none, so it never shows on them.
 * `referencedDefinitions` is a method row's inlined constant definitions
 * (bd tea-rags-mcp-d0z7b.4), part of its body.
 */
const BATCH_LEAN_FIELDS = [
  "symbolId",
  "relativePath",
  "kind",
  "startLine",
  "endLine",
  "content",
  "referencedDefinitions",
];

/** A `table:<name>` / `migration:<id>` address — answered from the migration corpus, not the code index (bd tea-rags-mcp-nplgm). */
function isMigrationCorpusAddress(symbol: string): boolean {
  return symbol.startsWith(RAILS_TABLE_ID_PREFIX) || symbol.startsWith(MIGRATION_ID_PREFIX);
}

/** `items` stably ordered by the first position of their request in `symbols`; an unknown request sorts last. */
function inRequestOrder<T>(symbols: readonly string[], items: readonly T[], requestOf: (item: T) => unknown): T[] {
  const rank = new Map<unknown, number>();
  symbols.forEach((symbol, i) => {
    if (!rank.has(symbol)) rank.set(symbol, i);
  });
  const rankOf = (item: T): number => rank.get(requestOf(item)) ?? symbols.length;
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.i - b.i)
    .map(({ item }) => item);
}
