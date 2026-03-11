/**
 * HybridSearchStrategy — combined dense + sparse (BM25) vector search.
 *
 * Validates that the collection has hybrid search enabled,
 * generates sparse vector from query, and executes hybrid search.
 * Extracted from MCP search.ts hybrid_search handler.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { BM25SparseVectorGenerator } from "../../adapters/qdrant/sparse.js";
import { HybridNotEnabledError, type RawResult, type SearchContext, type SearchStrategy } from "./types.js";

export class HybridSearchStrategy implements SearchStrategy {
  readonly type = "hybrid" as const;

  constructor(private readonly qdrant: QdrantManager) {}

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.embedding) {
      throw new Error("HybridSearchStrategy requires an embedding in the context.");
    }

    // Validate hybrid support on collection
    const collectionInfo = await this.qdrant.getCollectionInfo(ctx.collectionName);
    if (!collectionInfo.hybridEnabled) {
      throw new HybridNotEnabledError(ctx.collectionName);
    }

    // Generate sparse vector if not provided
    const sparseVector = ctx.sparseVector ?? BM25SparseVectorGenerator.generateSimple(ctx.query ?? "");

    const results = await this.qdrant.hybridSearch(
      ctx.collectionName,
      ctx.embedding,
      sparseVector,
      ctx.limit,
      ctx.filter,
    );
    return results;
  }
}
