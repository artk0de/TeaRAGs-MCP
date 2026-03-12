/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 */

import { BaseExploreStrategy } from "./base.js";
import type { ExploreResult, SearchContext } from "./types.js";

export class VectorSearchStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;

  protected async executeExplore(ctx: SearchContext): Promise<ExploreResult[]> {
    if (!ctx.embedding) {
      throw new Error("VectorSearchStrategy requires an embedding in the context.");
    }
    return this.qdrant.search(ctx.collectionName, ctx.embedding, ctx.limit, ctx.filter);
  }
}
