/**
 * VectorSearchStrategy — semantic vector search via Qdrant.
 *
 * Executes a dense vector search against a collection.
 * Extracted from MCP search.ts semantic_search handler.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { RawResult, SearchContext, SearchStrategy } from "./types.js";

export class VectorSearchStrategy implements SearchStrategy {
  readonly type = "vector" as const;

  constructor(private readonly qdrant: QdrantManager) {}

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.embedding) {
      throw new Error("VectorSearchStrategy requires an embedding in the context.");
    }
    const results = await this.qdrant.search(ctx.collectionName, ctx.embedding, ctx.limit, ctx.filter);
    return results;
  }
}
