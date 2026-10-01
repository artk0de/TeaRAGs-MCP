/**
 * BaseExploreStrategy — abstract base for all explore strategies.
 *
 * Template Method pattern:
 *   execute() = applyDefaults() → executeExplore() → postProcess()
 *
 * Concrete strategies implement only `executeExplore()` and `type`.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { fileScopeOf, reduceToFileScope, type FileScope } from "../chunk-grouping/file-scope.js";
import { filterMetaOnly } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { TestSetupHydrator } from "../test-setup-hydration.js";
import type { ExploreContext, ExploreResult, ExploreStrategy } from "./types.js";

/** Page size when the caller gives no (or a non-positive) limit. */
const FALLBACK_PAGE_SIZE = 5;

/**
 * The page size the CALLER asked for. A positive limit is honoured exactly —
 * the overfetch floor lives in `applyDefaults`' fetch size, never in the page
 * (tea-rags-mcp-9mwny: a `Math.max(limit, 5)` here returned 5 results for
 * limit 1/2/3 on every strategy that inherits postProcess).
 */
function requestedPageSize(limit: number | undefined): number {
  return limit !== undefined && limit > 0 ? limit : FALLBACK_PAGE_SIZE;
}

export abstract class BaseExploreStrategy implements ExploreStrategy {
  abstract readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";

  /** Payload keys a `level: "file"` hit keeps, derived once from payloadSignals. */
  private readonly fileScope: FileScope;

  /** Puts a test example's scope setup back in front of it (bd tea-rags-mcp-5xpq4). */
  private readonly testSetupHydrator: TestSetupHydrator;

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly reranker: Reranker,
    protected readonly payloadSignals: PayloadSignalDescriptor[],
    protected readonly essentialKeys: string[],
  ) {
    this.fileScope = fileScopeOf(payloadSignals);
    this.testSetupHydrator = new TestSetupHydrator(qdrant);
  }

  /** Main entry point: apply defaults → execute search → post-process. */
  async execute(ctx: ExploreContext): Promise<ExploreResult[]> {
    const prepared = this.applyDefaults(ctx);
    const rawResults = await this.executeExplore(prepared);
    return await this.postProcess(rawResults, ctx);
  }

  /** Concrete strategy implements the actual search call. */
  protected abstract executeExplore(ctx: ExploreContext): Promise<ExploreResult[]>;

  /**
   * Apply defaults to context before passing to executeExplore.
   * - Computes the FETCH size: overfetch ×4 with a non-relevance rerank, ×2
   *   otherwise, never below 20 — so a small page still reranks a real pool
   */
  protected applyDefaults(ctx: ExploreContext): ExploreContext {
    const requestedLimit = requestedPageSize(ctx.limit);
    const effectiveOffset = ctx.offset || 0;
    const rerank = ctx.rerank as RerankMode<string> | undefined;
    const needsOverfetch = Boolean(rerank && rerank !== "relevance");
    const multiplier = needsOverfetch ? 4 : 2;
    const fetchLimit = Math.max(20, (requestedLimit + effectiveOffset) * multiplier);
    return { ...ctx, limit: fetchLimit };
  }

  /**
   * Post-process raw results:
   *   1. Rerank (if non-relevance preset)
   *   2. Trim to requested limit
   *   3. Reduce file-level hits to file scope (after ranking — see `shapeFileLevel`)
   *   4. metaOnly formatting (if ctx.metaOnly), else test setup hydration
   */
  protected async postProcess(results: ExploreResult[], originalCtx: ExploreContext): Promise<ExploreResult[]> {
    const requestedLimit = requestedPageSize(originalCtx.limit);
    const rerank = originalCtx.rerank as RerankMode<string> | undefined;

    // 1. Rerank
    let filtered =
      rerank && rerank !== "relevance"
        ? await this.reranker.rerank(results, rerank, "semantic_search", {
            signalLevel: originalCtx.level,
            query: originalCtx.query,
          })
        : results;

    // 2. Offset + trim to requested limit
    const effectiveOffset = originalCtx.offset || 0;
    if (effectiveOffset > 0) {
      filtered = filtered.slice(effectiveOffset);
    }
    filtered = filtered.slice(0, requestedLimit);

    // 3. File scope
    filtered = this.shapeFileLevel(filtered, originalCtx);

    // 4. metaOnly formatting
    if (originalCtx.metaOnly) {
      return this.applyMetaOnly(filtered);
    }

    return this.hydrateTestSetup(filtered, originalCtx);
  }

  /**
   * The final page with every test example's scope setup prepended to its
   * content (bd tea-rags-mcp-5xpq4) — ONE batched fetch per page. The single
   * hydration seam: every strategy calls it as the last step of a
   * content-bearing answer, after ranking, slicing and file-scope shaping, so
   * only the returned page pays and a file-level hit (whose `setupScopeIds`
   * the file scope dropped) never does. A metaOnly answer carries no content
   * and never calls it.
   */
  protected async hydrateTestSetup(results: ExploreResult[], ctx: ExploreContext): Promise<ExploreResult[]> {
    return this.testSetupHydrator.hydrate(results, ctx.collectionName);
  }

  /**
   * At `level: "file"`, reduce each hit's payload to the fields describing the
   * file (bd tea-rags-mcp-mwq0k). Runs AFTER rerank: ranking reads the full
   * representative chunk payload, the response carries only file scope.
   * `rankingOverlay` is a sibling of the payload and passes through untouched.
   */
  protected shapeFileLevel(results: ExploreResult[], ctx: ExploreContext): ExploreResult[] {
    if (ctx.level !== "file") return results;
    return results.map((result) =>
      result.payload ? { ...result, payload: reduceToFileScope(result.payload, this.fileScope) } : result,
    );
  }

  /**
   * Apply metaOnly formatting: strip raw content, keep metadata from payloadSignals.
   * Wraps filterMetaOnly output back as ExploreResult[]; the score stays on the
   * hit, never copied into its payload (bd tea-rags-mcp-947xf). The
   * rankingOverlay stays too: the metaOnly payload is raw, so the overlay is
   * the only place a reranked hit's labels live.
   */
  protected applyMetaOnly(results: ExploreResult[]): ExploreResult[] {
    const metaResults = filterMetaOnly(results, this.payloadSignals, this.essentialKeys);
    return metaResults.map((meta, i) => {
      const { id, score, rankingOverlay } = results[i];
      return rankingOverlay ? { id, score, payload: meta, rankingOverlay } : { id, score, payload: meta };
    });
  }
}
