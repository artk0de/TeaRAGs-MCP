import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class OnboardingPreset implements RerankPreset {
  readonly name = "onboarding";
  readonly description = "Documentation and stable code for new team members";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = { similarity: 0.4, documentation: 0.3, stability: 0.3 };
  readonly overlayMask: OverlayMask = {
    file: ["commitCount"],
    chunk: ["commitCount"],
  };
}
