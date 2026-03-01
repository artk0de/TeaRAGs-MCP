import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class OwnershipPreset implements RerankPreset {
  readonly name = "ownership";
  readonly description = "Code with single dominant author — knowledge transfer risk";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = { similarity: 0.4, ownership: 0.35, knowledgeSilo: 0.25 };
  readonly overlayMask: OverlayMask = {
    file: ["dominantAuthorPct", "contributorCount"],
  };
}
