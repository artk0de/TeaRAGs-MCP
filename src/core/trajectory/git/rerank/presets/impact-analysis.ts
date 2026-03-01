import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class ImpactAnalysisPreset implements RerankPreset {
  readonly name = "impactAnalysis";
  readonly description = "Highly-imported modules — changes affect many dependents";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = { similarity: 0.5, imports: 0.5 };
  readonly overlayMask: OverlayMask = {
    derived: ["imports"],
  };
}
