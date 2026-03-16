import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Find large, dense methods and blocks — candidates for decomposition.
 *
 * Use when: looking for methods/functions that should be split into smaller units,
 *   identifying monolithic code blocks, planning extract-method refactorings.
 * Query examples: "request handler", "data processor", "render method".
 * Key signals: chunkSize (large methods), chunkDensity (dense code = complex logic).
 *   Similarity stays high (0.4) to keep results relevant to the query.
 * Groups results by parentName — shows which classes contain oversized methods.
 * Compare: RefactoringPreset adds git signals (churn, volatility);
 *   DecompositionPreset is purely structural — no git history needed.
 */
export class DecompositionPreset implements RerankPreset {
  readonly name = "decomposition";
  readonly description = "Find large, dense methods and blocks — candidates for decomposition";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.4,
    chunkSize: 0.4,
    chunkDensity: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    file: ["methodLines"],
  };
  readonly groupBy = "parentName";
}
