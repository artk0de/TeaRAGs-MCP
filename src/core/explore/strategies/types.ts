/**
 * Explore strategy types — shared interface for all explore execution strategies.
 *
 * Strategies encapsulate the business logic of how an explore operation is executed
 * (vector, hybrid, scroll-rank) while keeping the MCP layer thin.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { calculateFetchLimit, filterResultsByGlob } from "../../adapters/qdrant/filters/index.js";
import type { RankingOverlay } from "../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { filterMetaOnly } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";

export interface SearchContext {
  collectionName: string;
  query?: string;
  embedding?: number[];
  sparseVector?: { indices: number[]; values: number[] };
  limit: number;
  filter?: Record<string, unknown>;
  weights?: Record<string, number>;
  level?: "chunk" | "file";
  presetName?: string;
  offset?: number;
  pathPattern?: string;
  rerank?: unknown; // RerankMode<string> — unknown to avoid circular deps
  metaOnly?: boolean;
}

export interface RawResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
}

export interface SearchStrategy {
  readonly type: "vector" | "hybrid" | "scroll-rank";
  execute: (ctx: SearchContext) => Promise<RawResult[]>;
}

/**
 * BaseExploreStrategy — abstract base for all explore strategies.
 *
 * Template Method pattern:
 *   execute() = applyDefaults() → executeSearch() → postProcess()
 *
 * Concrete strategies implement only `executeSearch()` and `type`.
 */
export abstract class BaseExploreStrategy implements SearchStrategy {
  abstract readonly type: "vector" | "hybrid" | "scroll-rank";

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly reranker: Reranker,
    private readonly payloadSignals: PayloadSignalDescriptor[],
    private readonly essentialKeys: string[],
  ) {}

  /** Main entry point: apply defaults → execute search → post-process. */
  async execute(ctx: SearchContext): Promise<RawResult[]> {
    const prepared = this.applyDefaults(ctx);
    const rawResults = await this.executeSearch(prepared);
    return this.postProcess(rawResults, ctx);
  }

  /** Concrete strategy implements the actual search call. */
  protected abstract executeSearch(ctx: SearchContext): Promise<RawResult[]>;

  /**
   * Apply defaults to context before passing to executeSearch.
   * - Enforces minimum limit of 5
   * - Computes overfetch limit when pathPattern or non-relevance rerank present
   * Returns a new context with adjusted limit (fetchLimit for Qdrant).
   */
  protected applyDefaults(ctx: SearchContext): SearchContext {
    const requestedLimit = Math.max(ctx.limit ?? 0, 5);
    const rerank = ctx.rerank as RerankMode<string> | undefined;
    const needsOverfetch = Boolean(ctx.pathPattern) || Boolean(rerank && rerank !== "relevance");
    const fetchLimit = calculateFetchLimit(requestedLimit, needsOverfetch);
    return { ...ctx, limit: fetchLimit };
  }

  /**
   * Post-process raw results:
   *   1. Glob filter (if pathPattern present)
   *   2. Rerank (if non-relevance preset)
   *   3. Trim to requested limit
   *   4. metaOnly formatting (if ctx.metaOnly)
   */
  protected postProcess(results: RawResult[], originalCtx: SearchContext): RawResult[] {
    const requestedLimit = Math.max(originalCtx.limit ?? 0, 5);
    const rerank = originalCtx.rerank as RerankMode<string> | undefined;

    // 1. Glob filter
    let filtered: RawResult[] = originalCtx.pathPattern
      ? filterResultsByGlob(results, originalCtx.pathPattern)
      : results;

    // 2. Rerank
    if (rerank && rerank !== "relevance") {
      filtered = this.reranker.rerank(filtered, rerank, "semantic_search");
    }

    // 3. Trim to requested limit
    filtered = filtered.slice(0, requestedLimit);

    // 4. metaOnly formatting
    if (originalCtx.metaOnly) {
      return this.applyMetaOnly(filtered);
    }

    return filtered;
  }

  /**
   * Apply metaOnly formatting: strip raw content, keep metadata from payloadSignals.
   * Wraps filterMetaOnly output back as RawResult[].
   */
  protected applyMetaOnly(results: RawResult[]): RawResult[] {
    const metaResults = filterMetaOnly(results, this.payloadSignals, this.essentialKeys);
    return metaResults.map((meta) => ({
      score: meta.score as number,
      payload: meta,
    }));
  }
}

/**
 * Error thrown when hybrid search is attempted on a collection
 * that does not have hybrid search enabled.
 */
export class HybridNotEnabledError extends Error {
  constructor(collectionName: string) {
    super(
      `Collection "${collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
    );
    this.name = "HybridNotEnabledError";
  }
}
