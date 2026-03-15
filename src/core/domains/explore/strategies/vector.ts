/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 */

import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

export class VectorSearchStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    if (!ctx.embedding) {
      throw new Error("VectorSearchStrategy requires an embedding in the context.");
    }
    if (ctx.level === "file") {
      return this.qdrant.queryGroups(ctx.collectionName, ctx.embedding, {
        groupBy: "relativePath",
        groupSize: 1,
        limit: ctx.limit,
        filter: ctx.filter,
      });
    }
    return this.qdrant.search(ctx.collectionName, ctx.embedding, ctx.limit, ctx.filter);
  }
}
