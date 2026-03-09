import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class DecompositionPreset implements RerankPreset {
  readonly name = "decomposition";
  readonly description = "Find large, dense methods and blocks — candidates for decomposition";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    chunkSize: 0.35,
    chunkDensity: 0.35,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["chunkSize", "chunkDensity"],
  };
}
