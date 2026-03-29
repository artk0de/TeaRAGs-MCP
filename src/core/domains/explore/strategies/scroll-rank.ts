/**
 * ScrollRankStrategy — scroll-based chunk ranking without vector search.
 *
 * Overrides applyDefaults (metaOnly=true, offset, weights resolution)
 * and postProcess (offset slicing, own limit logic — no overfetch).
 */

import { scrollOrderedBy } from "../../../adapters/qdrant/scroll.js";
import type { RankingOverlay, RerankableResult } from "../../../contracts/types/reranker.js";
import { InvalidQueryError } from "../errors.js";
import { RankModule, type RankOptions } from "../rank-module.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/** Initial overfetch multiplier for file-level dedup. */
const FILE_OVERFETCH_INITIAL = 3;
/** Max adaptive re-fetch rounds before giving up. */
const FILE_OVERFETCH_MAX_ROUNDS = 3;

export class ScrollRankStrategy extends BaseExploreStrategy {
  readonly type = "scroll-rank" as const;
  private readonly rankModule: RankModule;

  constructor(...args: ConstructorParameters<typeof BaseExploreStrategy>) {
    super(...args);
    this.rankModule = new RankModule(this.reranker, this.reranker.getDescriptors());
  }

  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    const metaOnly = ctx.metaOnly !== false; // defaults to true for rank_chunks
    const effectiveOffset = ctx.offset || 0;
    const requestedLimit = ctx.limit || 10;
    const baseLimit = requestedLimit + effectiveOffset;

    // Resolve preset → weights (Reranker is Information Expert)
    let { weights } = ctx;
    let { presetName } = ctx;
    if (!weights && ctx.rerank) {
      if (typeof ctx.rerank === "string") {
        const preset = this.reranker.getPreset(ctx.rerank, "rank_chunks");
        if (!preset) throw new InvalidQueryError(`Unknown preset "${ctx.rerank}" for rank_chunks`);
        weights = Object.fromEntries(
          Object.entries(preset).filter((e): e is [string, number] => typeof e[1] === "number"),
        );
        presetName = ctx.rerank;
      } else if (typeof ctx.rerank === "object" && ctx.rerank !== null && "custom" in ctx.rerank) {
        weights = (ctx.rerank as { custom: Record<string, number> }).custom;
      }
    }

    return {
      ...ctx,
      limit: baseLimit,
      filter: ctx.filter,
      metaOnly,
      offset: effectiveOffset,
      weights,
      presetName,
    };
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const { weights } = ctx;
    if (!weights || Object.keys(weights).length === 0) {
      throw new InvalidQueryError("ScrollRankStrategy requires weights in the context");
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

    const baseOpts = {
      weights,
      level: ctx.level ?? "chunk",
      scrollFn,
      ensureIndexFn,
      filter: ctx.filter,
      presetName: ctx.presetName,
    };

    // Chunk-level: single fetch, no dedup needed
    if (ctx.level !== "file") {
      return this.fetchAndMap(ctx.collectionName, { ...baseOpts, limit: ctx.limit });
    }

    // File-level: adaptive fetch — increase limit until enough unique files
    const targetFiles = ctx.limit;
    let fetchLimit = targetFiles * FILE_OVERFETCH_INITIAL;
    let prevChunkCount = 0;

    for (let attempt = 0; attempt < FILE_OVERFETCH_MAX_ROUNDS; attempt++) {
      const results = await this.fetchAndMap(ctx.collectionName, { ...baseOpts, limit: fetchLimit });
      const uniqueFiles = new Set(results.map((r) => r.payload?.relativePath)).size;

      if (uniqueFiles >= targetFiles || results.length <= prevChunkCount) {
        return results;
      }

      prevChunkCount = results.length;
      fetchLimit *= 2;
    }

    return this.fetchAndMap(ctx.collectionName, { ...baseOpts, limit: fetchLimit });
  }

  private async fetchAndMap(collectionName: string, opts: RankOptions): Promise<ExploreResult[]> {
    const results = await this.rankModule.rankChunks(collectionName, opts);
    return results.map((r) => {
      const withOverlay = r as RerankableResult & { rankingOverlay?: RankingOverlay };
      return {
        id: r.id,
        score: r.score,
        payload: r.payload as Record<string, unknown> | undefined,
        rankingOverlay: withOverlay.rankingOverlay,
      };
    });
  }

  protected override postProcess(results: ExploreResult[], originalCtx: ExploreContext): ExploreResult[] {
    let processed = results;

    // File-level dedup: keep highest-scored chunk per file
    if (originalCtx.level === "file") {
      processed = this.groupByFile(processed, processed.length);
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
