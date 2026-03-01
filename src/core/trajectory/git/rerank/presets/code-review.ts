import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class CodeReviewPreset implements RerankPreset {
  readonly name = "codeReview";
  readonly description = "Surface recent high-activity code for review";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.35,
    recency: 0.15,
    burstActivity: 0.15,
    density: 0.15,
    chunkChurn: 0.2,
    blockPenalty: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["recency", "burstActivity", "chunkChurn", "density"],
    raw: {
      file: ["ageDays", "recencyWeightedFreq", "changeDensity"],
      chunk: ["commitCount"],
    },
  };
}
