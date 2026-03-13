import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

export class DecompositionPreset implements RerankPreset {
  readonly name = "decomposition";
  readonly description = "Find large, dense methods and blocks — candidates for decomposition";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.4,
    chunkSize: 0.4,
    chunkDensity: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["chunkSize", "chunkDensity"],
  };
  readonly groupBy = "parentName";
}
