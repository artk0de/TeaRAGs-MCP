import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface recently active code for review.
 *
 * Use when: preparing a code review, checking what's been worked on, reviewing
 *   recent PRs, or auditing changes in a specific area.
 * Query examples: "payment processing changes", "recent auth updates".
 * Key signals: recency + burstActivity identify freshly modified code;
 *   chunkChurn + chunkRelativeChurn highlight chunks getting disproportionate attention.
 * Compare: RecentPreset is lighter (similarity-dominant); CodeReviewPreset adds
 *   chunk-level churn detail for more targeted review.
 */
export class CodeReviewPreset implements RerankPreset {
  readonly name = "codeReview";
  readonly description = "Surface recent high-activity code for review";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    recency: 0.15,
    burstActivity: 0.1,
    density: 0.1,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.1,
    blockPenalty: -0.1,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "recencyWeightedFreq", "changeDensity"],
    chunk: ["commitCount", "churnRatio"],
  };
}
