import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

export class TechDebtPreset implements RerankPreset {
  readonly name = "techDebt";
  readonly description = "Find legacy code with high churn, old age, and frequent bug fixes";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    age: 0.15,
    churn: 0.15,
    bugFix: 0.15,
    volatility: 0.1,
    knowledgeSilo: 0.1,
    density: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "commitCount", "bugFixRate", "churnVolatility", "changeDensity"],
  };
}
