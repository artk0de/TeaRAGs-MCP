/**
 * Search strategy factory — creates the appropriate strategy for a search type.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { Reranker } from "../reranker.js";
import { HybridSearchStrategy } from "./hybrid.js";
import { ScrollRankStrategy } from "./scroll-rank.js";
import type { SearchStrategy } from "./types.js";
import { VectorSearchStrategy } from "./vector.js";

export type SearchStrategyType = "vector" | "hybrid" | "scroll-rank";

export function createSearchStrategy(
  type: SearchStrategyType,
  qdrant: QdrantManager,
  reranker: Reranker,
): SearchStrategy {
  switch (type) {
    case "vector":
      return new VectorSearchStrategy(qdrant);
    case "hybrid":
      return new HybridSearchStrategy(qdrant);
    case "scroll-rank":
      return new ScrollRankStrategy(qdrant, reranker);
    default:
      throw new Error(`Unknown search strategy type: ${type as string}`);
  }
}
