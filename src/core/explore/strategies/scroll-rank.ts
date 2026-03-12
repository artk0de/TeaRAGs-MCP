/**
 * ScrollRankStrategy — scroll-based chunk ranking without vector search.
 *
 * Overrides applyDefaults (metaOnly=true, offset, excludeDocumentation, weights resolution)
 * and postProcess (offset slicing, own limit logic — no overfetch).
 */

import { filterResultsByGlob } from "../../adapters/qdrant/filters/index.js";
import { scrollOrderedBy } from "../../adapters/qdrant/scroll.js";
import type { RerankableResult } from "../../contracts/types/reranker.js";
import { RankModule } from "../rank-module.js";
import { BaseExploreStrategy } from "./types.js";
import type { ExploreResult, SearchContext } from "./types.js";

export class ScrollRankStrategy extends BaseExploreStrategy {
  readonly type = "scroll-rank" as const;
  private readonly rankModule: RankModule;

  constructor(
    ...args: ConstructorParameters<typeof BaseExploreStrategy>
  ) {
    super(...args);
    this.rankModule = new RankModule(this.reranker, this.reranker.getDescriptors());
  }

  protected applyDefaults(ctx: SearchContext): SearchContext {
    const metaOnly = ctx.metaOnly !== false; // defaults to true for rank_chunks
    const effectiveOffset = ctx.offset || 0;
    const requestedLimit = ctx.limit || 10;
    const fetchLimit = requestedLimit + effectiveOffset;
    const effectiveFilter = excludeDocumentation(ctx.filter);

    // Resolve preset → weights (Reranker is Information Expert)
    let weights = ctx.weights;
    let presetName = ctx.presetName;
    if (!weights && ctx.rerank) {
      if (typeof ctx.rerank === "string") {
        const preset = this.reranker.getPreset(ctx.rerank, "rank_chunks");
        if (!preset) throw new Error(`Unknown preset "${ctx.rerank}" for rank_chunks.`);
        weights = Object.fromEntries(
          Object.entries(preset).filter((e): e is [string, number] => typeof e[1] === "number"),
        );
        presetName = ctx.rerank;
      } else if (typeof ctx.rerank === "object" && ctx.rerank !== null && "custom" in ctx.rerank) {
        weights = (ctx.rerank as { custom: Record<string, number> }).custom;
      }
    }

    return { ...ctx, limit: fetchLimit, filter: effectiveFilter, metaOnly, offset: effectiveOffset, weights, presetName };
  }

  protected async executeExplore(ctx: SearchContext): Promise<ExploreResult[]> {
    const { weights } = ctx;
    if (!weights || Object.keys(weights).length === 0) {
      throw new Error("ScrollRankStrategy requires weights in the context.");
    }

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

    const results: RerankableResult[] = await this.rankModule.rankChunks(ctx.collectionName, {
      weights,
      level: ctx.level ?? "chunk",
      limit: ctx.limit,
      scrollFn,
      ensureIndexFn,
      filter: ctx.filter,
      presetName: ctx.presetName,
    });

    return results.map((r) => ({
      score: r.score,
      payload: r.payload as Record<string, unknown> | undefined,
    }));
  }

  protected postProcess(results: ExploreResult[], originalCtx: SearchContext): ExploreResult[] {
    let processed = results;

    if (originalCtx.pathPattern) {
      processed = filterResultsByGlob(processed, originalCtx.pathPattern);
    }

    const effectiveOffset = originalCtx.offset || 0;
    if (effectiveOffset > 0) {
      processed = processed.slice(effectiveOffset);
    }

    processed = processed.slice(0, originalCtx.limit || 10);

    const metaOnly = originalCtx.metaOnly !== false;
    if (metaOnly) {
      return this.applyMetaOnly(processed);
    }

    return processed;
  }
}

/**
 * Exclude documentation chunks from reranked results using must_not.
 * Uses must_not because code chunks don't have isDocumentation field at all —
 * Qdrant can't match {value: false} on a missing field.
 */
export function excludeDocumentation(filter?: Record<string, unknown>): Record<string, unknown> {
  const docExclusion = { key: "isDocumentation", match: { value: true } };
  if (!filter) {
    return { must_not: [docExclusion] };
  }
  const existing = filter.must_not;
  const mustNot = Array.isArray(existing) ? [...(existing as Record<string, unknown>[]), docExclusion] : [docExclusion];
  return { ...filter, must_not: mustNot };
}
