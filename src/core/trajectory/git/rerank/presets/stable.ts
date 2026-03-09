import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class StablePreset implements RerankPreset {
  readonly name = "stable";
  readonly description = "Boost low-churn, long-lived, predictable code";
  readonly tools = ["search_code", "semantic_search", "hybrid_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    stability: 0.2,
    age: 0.15,
    volatility: -0.1,
    ownership: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["commitCount", "ageDays", "churnVolatility", "dominantAuthorPct"],
    chunk: ["commitCount", "ageDays"],
  };
}
