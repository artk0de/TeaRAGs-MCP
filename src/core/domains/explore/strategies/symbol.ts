/**
 * SymbolSearchStrategy — find chunks by symbol name.
 *
 * Scrolls twice (symbolId + parentSymbolId), deduplicates by id, resolves
 * into outline/merged results via resolveSymbols. Filter construction
 * lives here; the facade only dispatches.
 *
 * Per-request strategy (takes input via constructor), mirroring
 * SimilarSearchStrategy.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import { applyEssentialSignalsToOverlay } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { resolveSymbols } from "../symbol-resolve.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/** Qdrant scroll page size for symbol discovery. */
const SCROLL_LIMIT = 200;

/** Default user-requested limit when caller doesn't specify one. */
const DEFAULT_USER_LIMIT = 50;

export interface SymbolSearchInput {
  symbol: string;
  language?: string;
  pathPattern?: string;
}

export class SymbolSearchStrategy extends BaseExploreStrategy {
  readonly type = "symbol" as unknown as "vector" | "hybrid" | "scroll-rank" | "similar";

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryRegistry,
    private readonly input: SymbolSearchInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** No overfetch — executeExplore scrolls a fixed SCROLL_LIMIT page. */
  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    return ctx;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const primaryFilter = this.buildSymbolFilter("symbolId");
    const parentFilter = this.buildSymbolFilter("parentSymbolId");

    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(ctx.collectionName, primaryFilter, SCROLL_LIMIT),
      this.qdrant.scrollFiltered(ctx.collectionName, parentFilter, SCROLL_LIMIT),
    ]);

    const seen = new Set(symbolChunks.map((c) => c.id));
    const allChunks = [...symbolChunks, ...memberChunks.filter((c) => !seen.has(c.id))];

    return resolveSymbols(allChunks, this.input.symbol, ctx.metaOnly) as ExploreResult[];
  }

  /**
   * Custom post-process — resolveSymbols already merges chunks into outline
   * results and strips payload.content on metaOnly. We keep that scaffolding
   * (chunkCount, mergedChunkIds, merged startLine/endLine) intact and only
   * adjust the git layer to match the semantic/hybrid contract:
   *
   *   metaOnly=true  → essential git keys + overlay signals (when reranked)
   *   metaOnly=false → full payload passes through unchanged
   *
   * Using BaseExploreStrategy.applyMetaOnly would strip synthetic outline
   * fields (not present in payloadSignals), so we apply a targeted git
   * filter via applyEssentialGitToResult instead.
   */
  protected override postProcess(results: ExploreResult[], originalCtx: ExploreContext): ExploreResult[] {
    let processed = results;

    const rerank = originalCtx.rerank as RerankMode<string> | undefined;
    if (rerank) {
      processed = this.reranker.rerank(processed, rerank, "semantic_search");
    }

    const offset = originalCtx.offset ?? 0;
    if (offset > 0) processed = processed.slice(offset);

    const limit = originalCtx.limit ?? DEFAULT_USER_LIMIT;
    processed = processed.slice(0, limit);

    if (originalCtx.metaOnly) {
      processed = processed.map((r) => applyEssentialSignalsToOverlay(r, this.essentialKeys) as ExploreResult);
    }

    return processed;
  }

  private buildSymbolFilter(key: "symbolId" | "parentSymbolId"): Record<string, unknown> {
    const must: Record<string, unknown>[] = [{ key, match: { text: this.input.symbol } }];
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    const filter: Record<string, unknown> = { must };
    if (!this.input.pathPattern) return filter;

    const extra = this.registry.buildMergedFilter(
      { pathPattern: this.input.pathPattern } as Record<string, unknown>,
      undefined,
      "chunk",
    );
    if (!extra) return filter;

    const extraMust = extra.must as Record<string, unknown>[] | undefined;
    if (extraMust) (filter.must as Record<string, unknown>[]).push(...extraMust);

    const extraMustNot = extra.must_not as Record<string, unknown>[] | undefined;
    if (extraMustNot) filter.must_not = extraMustNot;

    return filter;
  }
}
