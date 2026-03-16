/**
 * BaseExploreStrategy — abstract base for all explore strategies.
 *
 * Template Method pattern:
 *   execute() = applyDefaults() → executeExplore() → postProcess()
 *
 * Concrete strategies implement only `executeExplore()` and `type`.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SignalLevel } from "../../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { filterMetaOnly } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import type { ExploreContext, ExploreResult, ExploreStrategy } from "./types.js";

export abstract class BaseExploreStrategy implements ExploreStrategy {
  abstract readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly reranker: Reranker,
    private readonly payloadSignals: PayloadSignalDescriptor[],
    private readonly essentialKeys: string[],
  ) {}

  /** Main entry point: apply defaults → execute search → post-process. */
  async execute(ctx: ExploreContext): Promise<ExploreResult[]> {
    const prepared = this.applyDefaults(ctx);
    const rawResults = await this.executeExplore(prepared);
    return this.postProcess(rawResults, ctx);
  }

  /** Concrete strategy implements the actual search call. */
  protected abstract executeExplore(ctx: ExploreContext): Promise<ExploreResult[]>;

  /**
   * Apply defaults to context before passing to executeExplore.
   * - Enforces minimum limit of 5
   * - Computes overfetch limit when non-relevance rerank present
   */
  protected applyDefaults(ctx: ExploreContext): ExploreContext {
    const requestedLimit = Math.max(ctx.limit ?? 0, 5);
    const rerank = ctx.rerank as RerankMode<string> | undefined;
    const needsOverfetch = Boolean(rerank && rerank !== "relevance");
    const multiplier = needsOverfetch ? 4 : 2;
    const fetchLimit = Math.max(20, requestedLimit * multiplier);
    return { ...ctx, limit: fetchLimit };
  }

  /**
   * Post-process raw results:
   *   1. Rerank (if non-relevance preset)
   *   2. Trim to requested limit
   *   3. metaOnly formatting (if ctx.metaOnly)
   */
  protected postProcess(results: ExploreResult[], originalCtx: ExploreContext): ExploreResult[] {
    const requestedLimit = Math.max(originalCtx.limit ?? 0, 5);
    const rerank = originalCtx.rerank as RerankMode<string> | undefined;

    // 1. Rerank
    let filtered =
      rerank && rerank !== "relevance"
        ? this.reranker.rerank(results, rerank, "semantic_search", originalCtx.level as SignalLevel | undefined)
        : results;

    // 2. Trim to requested limit
    filtered = filtered.slice(0, requestedLimit);

    // 3. metaOnly formatting
    if (originalCtx.metaOnly) {
      return this.applyMetaOnly(filtered);
    }

    return filtered;
  }

  /**
   * Apply metaOnly formatting: strip raw content, keep metadata from payloadSignals.
   * Wraps filterMetaOnly output back as ExploreResult[].
   */
  protected applyMetaOnly(results: ExploreResult[]): ExploreResult[] {
    const metaResults = filterMetaOnly(results, this.payloadSignals, this.essentialKeys);
    return metaResults.map((meta) => ({
      score: meta.score as number,
      payload: meta,
    }));
  }

  /** Client-side dedup: keep highest-scored hit per file (for file-level grouping). */
  protected groupByFile(results: ExploreResult[], limit: number): ExploreResult[] {
    const seen = new Map<string, ExploreResult>();
    for (const r of results) {
      const path = (r.payload?.relativePath as string) ?? "";
      if (!seen.has(path)) seen.set(path, r);
    }
    return [...seen.values()].slice(0, limit);
  }
}
