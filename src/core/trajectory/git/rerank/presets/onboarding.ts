import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class OnboardingPreset implements RerankPreset {
  readonly name = "onboarding";
  readonly description = "Well-documented, stable, mature code with shared ownership — ideal for new team members";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    documentation: 0.2,
    stability: 0.2,
    age: 0.1,
    ownership: -0.1,
    volatility: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: ["commitCount", "ageDays", "dominantAuthorPct", "churnVolatility"],
    chunk: ["commitCount", "ageDays"],
  };
}
