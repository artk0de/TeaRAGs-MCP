/**
 * ExploreFacade - Public API for code exploration and search.
 *
 * Delegates to:
 * - ExploreModule: semantic code search over indexed collections
 * - Post-process pipeline: computeFetchLimit, postProcess, filterMetaOnly
 * - RankModule: scroll-based chunk ranking without vector search
 *
 * Cold-start: loads cached collection stats into reranker on first search.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { filterResultsByGlob } from "../adapters/qdrant/filters/index.js";
import { scrollOrderedBy } from "../adapters/qdrant/scroll.js";
import { BM25SparseVectorGenerator } from "../adapters/qdrant/sparse.js";
import { ExploreModule } from "../explore/explore-module.js";
import { computeFetchLimit, filterMetaOnly, postProcess } from "../explore/post-process.js";
import { RankModule } from "../explore/rank-module.js";
import type { Reranker } from "../explore/reranker.js";
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import { BASE_PAYLOAD_SIGNALS } from "../trajectory/static/payload-signals.js";
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
import type { SchemaDriftMonitor } from "./schema-drift-monitor.js";
import type { StatsCache } from "./stats-cache.js";

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

class HybridNotEnabledError extends Error {
  constructor(collectionName: string) {
    super(
      `Collection "${collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
    );
    this.name = "HybridNotEnabledError";
  }
}

class UnknownPresetError extends Error {
  constructor(presetName: string, tool: string) {
    super(`Unknown preset "${presetName}" for ${tool}.`);
    this.name = "UnknownPresetError";
  }
}

// ---------------------------------------------------------------------------
// ExploreFacade
// ---------------------------------------------------------------------------

export class ExploreFacade {
  private readonly essentialTrajectoryFields: string[];
  private readonly schemaDriftMonitor?: SchemaDriftMonitor;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: ExploreCodeConfig,
    private readonly reranker: Reranker,
    private readonly registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
    essentialTrajectoryFields?: string[],
    schemaDriftMonitor?: SchemaDriftMonitor,
  ) {
    this.essentialTrajectoryFields = essentialTrajectoryFields ?? [];
    this.schemaDriftMonitor = schemaDriftMonitor;
  }

  // =========================================================================
  // semanticSearch
  // =========================================================================

  /** Semantic (dense vector) search over a collection. */
  async semanticSearch(request: SemanticSearchRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    await this.validateCollectionExists(collectionName, path);
    await this.ensureStats(collectionName);

    const { embedding } = await this.embeddings.embed(request.query);
    const { requestedLimit, fetchLimit } = computeFetchLimit(request.limit, request.pathPattern, request.rerank);
    const results = await this.qdrant.search(collectionName, embedding, fetchLimit, request.filter);

    const processed = postProcess(results, {
      pathPattern: request.pathPattern,
      rerank: request.rerank,
      limit: requestedLimit,
      reranker: this.reranker,
    });

    const searchResults = this.toSearchResults(processed);
    const finalResults = request.metaOnly ? this.applyMetaOnly(searchResults) : searchResults;
    const driftWarning = await this.checkDrift(path, collectionName);

    return { results: finalResults, driftWarning };
  }

  // =========================================================================
  // hybridSearch
  // =========================================================================

  /** Hybrid (dense + BM25 sparse) search over a collection. */
  async hybridSearch(request: HybridSearchRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    await this.validateCollectionExists(collectionName, path);
    await this.ensureStats(collectionName);

    // Validate hybrid support
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    if (!collectionInfo.hybridEnabled) {
      throw new HybridNotEnabledError(collectionName);
    }

    const { embedding } = await this.embeddings.embed(request.query);
    const sparseVector = BM25SparseVectorGenerator.generateSimple(request.query);
    const { requestedLimit, fetchLimit } = computeFetchLimit(request.limit, request.pathPattern, request.rerank);

    const results = await this.qdrant.hybridSearch(collectionName, embedding, sparseVector, fetchLimit, request.filter);

    const processed = postProcess(results, {
      pathPattern: request.pathPattern,
      rerank: request.rerank,
      limit: requestedLimit,
      reranker: this.reranker,
    });

    const searchResults = this.toSearchResults(processed);
    const finalResults = request.metaOnly ? this.applyMetaOnly(searchResults) : searchResults;
    const driftWarning = await this.checkDrift(path, collectionName);

    return { results: finalResults, driftWarning };
  }

  // =========================================================================
  // rankChunks
  // =========================================================================

  /** Rank all chunks by rerank signals without vector search. */
  async rankChunks(request: RankChunksRequest): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(request.collection, request.path);
    await this.validateCollectionExists(collectionName, path);
    await this.ensureStats(collectionName);

    // Resolve weights
    let sourceWeights: Record<string, number | undefined>;
    let presetName: string | undefined;

    if (typeof request.rerank === "string") {
      const preset = this.reranker.getPreset(request.rerank, "rank_chunks");
      if (!preset) {
        throw new UnknownPresetError(request.rerank, "rank_chunks");
      }
      sourceWeights = preset;
      presetName = request.rerank;
    } else {
      sourceWeights = request.rerank.custom;
    }

    const weights: Record<string, number> = Object.fromEntries(
      Object.entries(sourceWeights).filter((e): e is [string, number] => typeof e[1] === "number"),
    );

    const rankModule = new RankModule(this.reranker, this.reranker.getDescriptors());

    const scrollFn = async (
      col: string,
      orderBy: { key: string; direction: "asc" | "desc" },
      lim: number,
      f?: Record<string, unknown>,
    ) => scrollOrderedBy(this.qdrant, col, orderBy, lim, f);

    const ensureIndexFn = async (col: string, fieldName: string) => {
      const isInteger = /count|days|lines/i.test(fieldName);
      await this.qdrant.ensurePayloadIndex(col, fieldName, isInteger ? "integer" : "float");
    };

    const effectiveOffset = request.offset || 0;
    const fetchLimit = (request.limit || 10) + effectiveOffset;

    // Exclude documentation from reranked results
    const effectiveFilter = excludeDocumentation(request.filter);

    let results = await rankModule.rankChunks(collectionName, {
      weights,
      level: request.level,
      limit: fetchLimit,
      scrollFn,
      ensureIndexFn,
      filter: effectiveFilter,
      presetName,
    });

    // Apply pathPattern client-side
    if (request.pathPattern) {
      results = filterResultsByGlob(results as never, request.pathPattern);
    }

    // Apply offset
    if (effectiveOffset > 0) {
      results = results.slice(effectiveOffset);
    }

    const searchResults = this.toSearchResults(results as never);

    // metaOnly defaults to true for rank_chunks
    const metaOnly = request.metaOnly !== false;
    const finalResults = metaOnly ? this.applyMetaOnly(searchResults) : searchResults;
    const driftWarning = await this.checkDrift(path, collectionName);

    return { results: finalResults, driftWarning };
  }

  // =========================================================================
  // searchCodeTyped
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

  // =========================================================================
  // searchCode (existing)
  // =========================================================================

  /** Search code semantically (original API). */
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

  /** Resolve collection name from collection or path. At least one must be provided. */
  private resolveCollection(collection?: string, path?: string): { collectionName: string; path?: string } {
    if (!collection && !path) {
      throw new CollectionRefError();
    }
    // path is guaranteed non-empty when collection is empty (checked above)
    const collectionName = collection || resolveCollectionName(path as string);
    return { collectionName, path };
  }

  /** Validate that a collection exists in Qdrant. */
  private async validateCollectionExists(collectionName: string, path?: string): Promise<void> {
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new CollectionNotFoundError(collectionName, path);
    }
  }

  /** Load cached collection stats into reranker (cold start). */
  private async ensureStats(collectionName: string): Promise<void> {
    if (this.statsCache && !this.reranker.hasCollectionStats) {
      await this.loadStatsFromCache(collectionName);
    }
  }

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

  /** Convert raw results to SearchResult shape. */
  private toSearchResults(
    results: { id?: string | number; score: number; payload?: Record<string, unknown>; rankingOverlay?: unknown }[],
  ): SearchResult[] {
    return results.map((r) => ({
      id: r.id ?? "",
      score: r.score,
      payload: r.payload,
      rankingOverlay: r.rankingOverlay as SearchResult["rankingOverlay"],
    }));
  }

  /** Apply metaOnly formatting using post-process module. */
  private applyMetaOnly(results: SearchResult[]): SearchResult[] {
    const metaResults = filterMetaOnly(results, BASE_PAYLOAD_SIGNALS, this.essentialTrajectoryFields);
    // Wrap meta objects as SearchResult (metaOnly returns flattened records)
    return metaResults.map((meta) => ({
      id: "",
      score: (meta.score as number) ?? 0,
      payload: meta,
    }));
  }

  /** Check schema drift — path-based or collection-based. */
  private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
    if (!this.schemaDriftMonitor) return null;
    if (path) {
      return this.schemaDriftMonitor.checkAndConsume(path);
    }
    if (collectionName) {
      return this.schemaDriftMonitor.checkByCollectionName(collectionName);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exclude documentation chunks from reranked results using must_not.
 * Uses must_not because code chunks don't have isDocumentation field at all —
 * Qdrant can't match {value: false} on a missing field.
 */
function excludeDocumentation(filter?: Record<string, unknown>): Record<string, unknown> {
  const docExclusion = { key: "isDocumentation", match: { value: true } };
  if (!filter) {
    return { must_not: [docExclusion] };
  }
  const existing = filter.must_not;
  const mustNot = Array.isArray(existing) ? [...(existing as Record<string, unknown>[]), docExclusion] : [docExclusion];
  return { ...filter, must_not: mustNot };
}

export { CollectionRefError, CollectionNotFoundError, HybridNotEnabledError, UnknownPresetError };
