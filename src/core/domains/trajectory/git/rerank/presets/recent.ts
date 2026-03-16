import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Boost recently modified code in search results.
 *
 * Use when: looking for actively developed code, finding recent implementations,
 *   or preferring fresh code over stale alternatives.
 * Query examples: "feature X implementation", "new API endpoints".
 * Key signals: recency (recent modification date), burstActivity (recent commit burst),
 *   density (sustained commit rate). Similarity stays dominant (0.5).
 * Compare: CodeReviewPreset adds chunk-level churn detail; RecentPreset is lighter
 *   and keeps similarity as the primary factor.
 * Available in search_code — the simplest preset for "give me relevant, recent code".
 */
export class RecentPreset implements RerankPreset {
  readonly name = "recent";
  readonly description = "Boost actively developed, recently modified code";
  readonly tools = ["search_code", "semantic_search", "hybrid_search", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    recency: 0.2,
    burstActivity: 0.15,
    density: 0.1,
    churn: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "recencyWeightedFreq", "changeDensity", "commitCount"],
    chunk: ["ageDays", "recencyWeightedFreq", "changeDensity", "commitCount"],
  };
}
