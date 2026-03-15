/**
 * HybridSearchStrategy — combined dense + sparse (BM25) vector search.
 *
 * Validates that the collection has hybrid search enabled,
 * generates sparse vector from query, and executes hybrid search.
 * Extracted from MCP search.ts hybrid_search handler.
 */

import { BM25SparseVectorGenerator } from "../../../adapters/qdrant/sparse.js";
import { BaseExploreStrategy } from "./base.js";
import { HybridNotEnabledError, type ExploreContext, type ExploreResult } from "./types.js";

export class HybridSearchStrategy extends BaseExploreStrategy {
  readonly type = "hybrid" as const;

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    if (!ctx.embedding) {
      throw new Error("HybridSearchStrategy requires an embedding in the context.");
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(ctx.collectionName);
    if (!collectionInfo.hybridEnabled) {
      throw new HybridNotEnabledError(ctx.collectionName);
    }

    const sparseVector = ctx.sparseVector ?? BM25SparseVectorGenerator.generateSimple(ctx.query ?? "");

    const results = await this.qdrant.hybridSearch(
      ctx.collectionName,
      ctx.embedding,
      sparseVector,
      ctx.level === "file" ? ctx.limit * 3 : ctx.limit,
      ctx.filter,
    );

    // Client-side grouping for file level (queryGroups doesn't support RRF fusion)
    if (ctx.level === "file") {
      return this.groupByFile(results, ctx.limit);
    }

    return results;
  }
}
