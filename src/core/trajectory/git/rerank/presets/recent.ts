import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class RecentPreset implements RerankPreset {
  readonly name = "recent";
  readonly description = "Boost actively developed, recently modified code";
  readonly tools = ["search_code", "semantic_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    recency: 0.2,
    burstActivity: 0.15,
    density: 0.1,
    churn: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "recencyWeightedFreq", "changeDensity", "commitCount"],
    chunk: ["ageDays", "recencyWeightedFreq", "changeDensity", "commitCount"],
  };
}
