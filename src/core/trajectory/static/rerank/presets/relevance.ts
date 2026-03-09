import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class RelevancePreset implements RerankPreset {
  readonly name = "relevance";
  readonly description = "Pure semantic similarity ranking";
  readonly tools = ["semantic_search", "hybrid_search", "search_code"];
  readonly weights: ScoringWeights = { similarity: 1.0 };
  readonly overlayMask: OverlayMask = {};
}
