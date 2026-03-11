/**
 * ScrollRankStrategy — scroll-based chunk ranking without vector search.
 *
 * Resolves preset weights, creates scroll/ensureIndex closures,
 * calls RankModule.rankChunks, and applies pathPattern + offset.
 * Extracted from MCP search.ts rank_chunks handler.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { filterResultsByGlob } from "../../adapters/qdrant/filters/index.js";
import { scrollOrderedBy } from "../../adapters/qdrant/scroll.js";
import type { RerankableResult } from "../../contracts/types/reranker.js";
import { RankModule } from "../rank-module.js";
import type { Reranker } from "../reranker.js";
import type { RawResult, SearchContext, SearchStrategy } from "./types.js";

export class ScrollRankStrategy implements SearchStrategy {
  readonly type = "scroll-rank" as const;
  private readonly rankModule: RankModule;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly reranker: Reranker,
  ) {
    this.rankModule = new RankModule(reranker, reranker.getDescriptors());
  }

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    // Resolve weights — must be provided by caller (factory resolves preset → weights)
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

    const effectiveOffset = ctx.offset || 0;
    const fetchLimit = (ctx.limit || 10) + effectiveOffset;

    // Exclude documentation from reranked results
    const effectiveFilter = excludeDocumentation(ctx.filter);

    let results: RerankableResult[] = await this.rankModule.rankChunks(ctx.collectionName, {
      weights,
      level: ctx.level ?? "chunk",
      limit: fetchLimit,
      scrollFn,
      ensureIndexFn,
      filter: effectiveFilter,
      presetName: ctx.presetName,
    });

    // Apply pathPattern client-side
    if (ctx.pathPattern) {
      results = filterResultsByGlob(results, ctx.pathPattern);
    }

    // Apply offset
    if (effectiveOffset > 0) {
      results = results.slice(effectiveOffset);
    }

    // Trim to requested limit
    results = results.slice(0, ctx.limit || 10);

    return results.map((r) => ({
      score: r.score,
      payload: r.payload as Record<string, unknown> | undefined,
    }));
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
