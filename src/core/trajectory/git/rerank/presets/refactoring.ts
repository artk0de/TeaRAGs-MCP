import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class RefactoringPreset implements RerankPreset {
  readonly name = "refactoring";
  readonly description = "Large, churning, volatile code — candidates for refactoring";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.15,
    chunkSize: 0.3,
    chunkDensity: 0.1,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.1,
    volatility: 0.1,
    bugFix: 0.05,
    age: 0.05,
    blockPenalty: -0.1,
  };
  readonly groupBy = "parentName";
  readonly overlayMask: OverlayMask = {
    derived: ["chunkSize", "chunkDensity", "chunkChurn", "volatility"],
    file: ["ageDays", "commitCount", "relativeChurn", "bugFixRate", "churnVolatility"],
    chunk: ["commitCount", "churnRatio"],
  };
}
