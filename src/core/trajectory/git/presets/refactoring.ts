import type { ScoringWeights } from "../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../contracts/types/reranker.js";

export class RefactoringPreset implements RerankPreset {
  readonly name = "refactoring";
  readonly description = "Large, churning, volatile code — candidates for refactoring";
  readonly tool = "semantic_search" as const;
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    chunkChurn: 0.15,
    relativeChurnNorm: 0.15,
    chunkSize: 0.15,
    volatility: 0.15,
    bugFix: 0.1,
    age: 0.1,
    blockPenalty: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["chunkChurn", "relativeChurnNorm", "chunkSize", "volatility", "bugFix", "age"],
    raw: {
      file: ["ageDays", "commitCount", "relativeChurn", "bugFixRate", "churnVolatility"],
      chunk: ["commitCount", "churnRatio"],
    },
  };
}
