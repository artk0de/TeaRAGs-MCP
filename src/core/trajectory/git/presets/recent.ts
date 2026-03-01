import type { ScoringWeights } from "../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../contracts/types/reranker.js";

export class RecentPreset implements RerankPreset {
  readonly name = "recent";
  readonly description = "Boost recently modified code";
  readonly tool = "search_code" as const;
  readonly tools = ["search_code"];
  readonly weights: ScoringWeights = { similarity: 0.7, recency: 0.3 };
  readonly overlayMask: OverlayMask = {
    derived: ["recency"],
    raw: { file: ["ageDays"] },
  };
}
