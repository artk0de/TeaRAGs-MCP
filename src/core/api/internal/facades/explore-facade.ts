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
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import {
  CollectionNotFoundError as DomainCollectionNotFoundError,
  InvalidQueryError,
} from "../../../domains/explore/errors.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { SchemaDriftMonitor } from "../../../infra/schema-drift-monitor.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import { InvalidParameterError } from "../../errors.js";
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
import { ExploreOps } from "../ops/explore-ops.js";

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

export class ExploreFacade {
  private readonly exploreOps: ExploreOps;

  constructor(deps: ExploreFacadeDeps) {
    this.exploreOps = new ExploreOps({
      qdrant: deps.qdrant,
      embeddings: deps.embeddings,
      reranker: deps.reranker,
      registry: deps.registry,
      statsCache: deps.statsCache,
      schemaDriftMonitor: deps.schemaDriftMonitor,
      payloadSignals: deps.payloadSignals ?? [],
      essentialKeys: deps.essentialKeys ?? [],
      modelGuard: deps.modelGuard,
    });
  }

  async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
    return this.exploreOps.semanticSearch(request);
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
    return this.exploreOps.findSimilar(request, this.exploreOps.buildSimilarStrategy(request));
  }

  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    validateFindSymbolRequest(request);
    return this.exploreOps.findSymbol(request);
  }

  async getIndexMetrics(path: string): Promise<IndexMetrics> {
    return this.exploreOps.getIndexMetrics(path);
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
