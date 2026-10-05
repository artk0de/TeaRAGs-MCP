/**
 * ExploreFacade — public delegation surface for explore/search operations.
 *
 * The facade does two things: (1) synchronous input validation, and
 * (2) delegation to ExploreOps. All pipeline work — resolve, guard,
 * ensureStats, embed, filter merge, strategy execution, drift warning —
 * lives in ExploreOps. Re-export of CollectionNotFoundError preserves
 * the existing public error name.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import type { SymbolChunkResolver, SymbolVisibilityResolver } from "../../../contracts/types/codegraph.js";
import type { PayloadSignalDescriptor, SignalFloors } from "../../../contracts/types/trajectory.js";
import {
  CollectionNotFoundError as DomainCollectionNotFoundError,
  InvalidQueryError,
} from "../../../domains/explore/errors.js";
import type { ExploreRequestScope } from "../../../domains/explore/request-scope.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import type { WorkingTreeOverlay } from "../../../domains/explore/working-tree/index.js";
import type { IndexDriftReporter } from "../../../domains/maintenance/drift/index.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type {
  ExploreCodeRequest,
  ExploreResponse,
  FindSimilarRequest,
  FindSymbolRequest,
  HybridSearchRequest,
  IndexMetrics,
  RankChunksRequest,
  SemanticSearchRequest,
} from "../../public/dto/index.js";
import type { WorkingTreeIndexTarget } from "../../public/dto/working-tree.js";
import { InvalidParameterError } from "../../public/errors.js";
import type { CollectionEmbeddingsResolver } from "../collection-embeddings.js";
import type { IndexHistoryAnchorResolver } from "../infra/index-history-anchor.js";
import { ExploreOps } from "../ops/explore-ops.js";

export interface ExploreFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  collectionRegistry: CollectionRegistry;
  statsCache?: StatsCache;
  driftReporter?: IndexDriftReporter;
  payloadSignals?: PayloadSignalDescriptor[];
  essentialKeys?: string[];
  modelGuard?: EmbeddingModelGuard;
  /** Per-collection provider + guard from the registry (bd tea-rags-mcp-b91f5), threaded through to ExploreOps. */
  collectionEmbeddings?: CollectionEmbeddingsResolver;
  chunkResolver?: SymbolChunkResolver;
  /** Declared visibility for find_symbol outline lines (bd tea-rags-mcp-sqqkz). */
  visibilityResolver?: SymbolVisibilityResolver;
  /** Per-language structural-signal floors, threaded through to IndexMetricsQuery. */
  signalFloors?: ReadonlyMap<string, SignalFloors>;
  /**
   * The frame of `get_index_metrics`' enrichment health for a path: the
   * provider keys of the ingest slice that serves that project, threaded
   * through to IndexMetricsQuery. Resolved per request because the slice is
   * per project (bd tea-rags-mcp-uebug).
   */
  enrichmentHealthFrameForPath?: (path: string) => readonly string[];
  /** The `workingTree` marker source (bd tea-rags-mcp-xi2r9), threaded through to ExploreOps. */
  workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  /** The query clock of an index (bd tea-rags-mcp-zwu7m), threaded through to ExploreOps. */
  historyAnchor?: Pick<IndexHistoryAnchorResolver, "anchorSecOf">;
}

export class ExploreFacade {
  private readonly exploreOps: ExploreOps;

  constructor(deps: ExploreFacadeDeps) {
    this.exploreOps = new ExploreOps({
      qdrant: deps.qdrant,
      embeddings: deps.embeddings,
      reranker: deps.reranker,
      registry: deps.registry,
      collectionRegistry: deps.collectionRegistry,
      statsCache: deps.statsCache,
      driftReporter: deps.driftReporter,
      payloadSignals: deps.payloadSignals ?? [],
      essentialKeys: deps.essentialKeys ?? [],
      modelGuard: deps.modelGuard,
      collectionEmbeddings: deps.collectionEmbeddings,
      chunkResolver: deps.chunkResolver,
      visibilityResolver: deps.visibilityResolver,
      signalFloors: deps.signalFloors,
      enrichmentHealthFrameForPath: deps.enrichmentHealthFrameForPath,
      workingTreeOverlay: deps.workingTreeOverlay,
      historyAnchor: deps.historyAnchor,
    });
  }

  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    return this.exploreOps.semanticSearch(request);
  }

  /**
   * Searches bound to one caller request's shared reads ({@link ExploreRequestScope}):
   * a caller running many searches for one answer probes the index and
   * measures the working tree once. The scope lives as long as the caller keeps it.
   */
  withRequestScope(scope: ExploreRequestScope): Pick<ExploreFacade, "semanticSearch"> {
    return { semanticSearch: async (request) => this.exploreOps.semanticSearch(request, scope) };
  }

  async hybridSearch(request: HybridSearchRequest): Promise<ExploreResponse> {
    return this.exploreOps.hybridSearch(request);
  }

  async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
    return this.exploreOps.rankChunks(request);
  }

  async searchCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
    return this.exploreOps.searchCode(request);
  }

  async findSimilar(request: FindSimilarRequest): Promise<ExploreResponse> {
    validateFindSimilarRequest(request);
    return this.exploreOps.findSimilar(request);
  }

  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    validateFindSymbolRequest(request);
    return this.exploreOps.findSymbol(request);
  }

  /** `collection`, when given, is the index read — the resolver's priority (collection > path). */
  async getIndexMetrics(path: string, collection?: string): Promise<IndexMetrics> {
    return this.exploreOps.getIndexMetrics(path, collection);
  }

  /** The base index a working-tree `path` is read against; undefined for an index's own checkout (D10). */
  async workingTreeIndexOf(path: string): Promise<WorkingTreeIndexTarget | undefined> {
    return this.exploreOps.workingTreeIndexOf(path);
  }
}

// ---------------------------------------------------------------------------
// Synchronous input validators — the only logic allowed in a facade file.
// ---------------------------------------------------------------------------

function validateFindSymbolRequest(request: FindSymbolRequest): void {
  if (request.symbol && request.relativePath) {
    throw new InvalidParameterError("symbol", "symbol and relativePath are mutually exclusive");
  }
  if (!request.symbol && !request.relativePath) {
    throw new InvalidParameterError("symbol", "either symbol or relativePath is required");
  }
}

export function validateFindSimilarRequest(request: FindSimilarRequest): void {
  const hasPositive =
    (request.positiveIds?.length ?? 0) > 0 ||
    (request.positiveCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;
  const hasNegative =
    (request.negativeIds?.length ?? 0) > 0 ||
    (request.negativeCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;

  const strategy = request.strategy ?? "best_score";
  if (strategy !== "best_score" && !hasPositive) {
    throw new InvalidQueryError(`Strategy '${strategy}' requires at least one positive input`);
  }
  if (!hasPositive && !hasNegative) {
    throw new InvalidQueryError("At least one positive or negative input is required");
  }
}

export { DomainCollectionNotFoundError as CollectionNotFoundError };
