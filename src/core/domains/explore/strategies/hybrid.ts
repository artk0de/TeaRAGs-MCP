/**
 * HybridSearchStrategy — combined dense + sparse (BM25) vector search.
 *
 * Validates that the collection has hybrid search enabled,
 * generates sparse vector from query, and executes hybrid search.
 * Extracted from MCP search.ts hybrid_search handler.
 */

import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import { FileLevelGrouper } from "../chunk-grouping/index.js";
import { InvalidQueryError } from "../errors.js";
import { BaseExploreStrategy } from "./base.js";
import { fetchPathPatternMatches } from "./path-pattern-fill.js";
import { buildSymbolIdentityFilter, isSymbolIdentifierQuery } from "./symbol-identity-leg.js";
import { HybridNotEnabledError, type ExploreContext, type ExploreResult } from "./types.js";

export class HybridSearchStrategy extends BaseExploreStrategy {
  readonly type = "hybrid" as const;

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const { embedding } = ctx;
    if (!embedding) {
      throw new InvalidQueryError("HybridSearchStrategy requires an embedding in the context");
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(ctx.collectionName);
    if (!collectionInfo.hybridEnabled) {
      throw new HybridNotEnabledError(ctx.collectionName);
    }

    const sparseVector = ctx.sparseVector ?? generateSparseVector(ctx.query ?? "");
    const fetchLimit = ctx.level === "file" ? ctx.limit * 3 : ctx.limit;

    // One identifier → add the identity leg (see ./symbol-identity-leg.ts);
    // any other query sends exactly the two-prefetch request it always did.
    const identityFilter = isSymbolIdentifierQuery(ctx.query) ? buildSymbolIdentityFilter(ctx.query) : undefined;
    const results = await fetchPathPatternMatches(
      ctx.pathPattern,
      { fetchLimit, fetchUnit: "chunk", target: ctx.limit, targetUnit: ctx.level === "file" ? "file" : "chunk" },
      async (limit) =>
        identityFilter
          ? this.qdrant.hybridSearch(
              ctx.collectionName,
              embedding,
              sparseVector,
              limit,
              ctx.filter,
              undefined,
              identityFilter,
            )
          : this.qdrant.hybridSearch(ctx.collectionName, embedding, sparseVector, limit, ctx.filter),
    );

    // queryGroups has no fusion=rrf option; fetch limit*3 above and group client-side.
    if (ctx.level === "file") {
      return FileLevelGrouper.group(results, ctx.limit);
    }

    return results;
  }
}
