import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class StablePreset implements RerankPreset {
  readonly name = "stable";
  readonly description = "Boost low-churn stable code";
  readonly tools = ["search_code"];
  readonly weights: ScoringWeights = { similarity: 0.7, stability: 0.3 };
  readonly overlayMask: OverlayMask = {
    derived: ["stability"],
    raw: { file: ["commitCount"] },
  };
}
