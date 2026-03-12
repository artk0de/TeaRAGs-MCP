/**
 * Explore strategy factory — creates the appropriate strategy for a search type.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import type { Reranker } from "../reranker.js";
import { HybridSearchStrategy } from "./hybrid.js";
import { ScrollRankStrategy } from "./scroll-rank.js";
import type { BaseExploreStrategy } from "./types.js";
import { VectorSearchStrategy } from "./vector.js";

export type SearchStrategyType = "vector" | "hybrid" | "scroll-rank";

export function createExploreStrategy(
  type: SearchStrategyType,
  qdrant: QdrantManager,
  reranker: Reranker,
  payloadSignals: PayloadSignalDescriptor[],
  essentialKeys: string[],
): BaseExploreStrategy {
  switch (type) {
    case "vector":
      return new VectorSearchStrategy(qdrant, reranker, payloadSignals, essentialKeys);
    case "hybrid":
      return new HybridSearchStrategy(qdrant, reranker, payloadSignals, essentialKeys);
    case "scroll-rank":
      return new ScrollRankStrategy(qdrant, reranker, payloadSignals, essentialKeys);
    default:
      throw new Error(`Unknown search strategy type: ${type as string}`);
  }
}
