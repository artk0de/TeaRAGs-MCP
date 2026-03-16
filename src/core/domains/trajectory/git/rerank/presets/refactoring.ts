import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Find large, churning, volatile code — candidates for refactoring.
 *
 * Use when: planning refactoring sprints, identifying god classes/methods,
 *   finding complex code that's hard to maintain.
 * Query examples: "data transformation", "request handler", "business logic".
 * Key signals: chunkSize (large methods = split candidates), chunkDensity (dense code),
 *   chunkChurn + chunkRelativeChurn (frequently patched chunks).
 * Groups results by parentName — shows which classes contain the worst methods.
 * Works well with rank_chunks + level:"chunk" for project-wide refactoring inventory.
 */
export class RefactoringPreset implements RerankPreset {
  readonly name = "refactoring";
  readonly description = "Large, churning, volatile code — candidates for refactoring";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
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
    file: ["ageDays", "commitCount", "relativeChurn", "bugFixRate", "churnVolatility"],
    chunk: ["commitCount", "churnRatio"],
  };
}
