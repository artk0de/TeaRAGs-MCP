import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class CodeReviewPreset implements RerankPreset {
  readonly name = "codeReview";
  readonly description = "Surface recent high-activity code for review";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    recency: 0.15,
    burstActivity: 0.1,
    density: 0.1,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.1,
    blockPenalty: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "recencyWeightedFreq", "changeDensity"],
    chunk: ["commitCount", "churnRatio"],
  };
}
