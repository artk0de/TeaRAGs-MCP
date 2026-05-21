import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `dangerous` — adds blast-radius (fanIn) so
 * bug-prone + single-owner code that's ALSO heavily depended on bubbles
 * to the top. Pure git signal without fanIn told you which code is
 * risky to TOUCH; adding fanIn tells you which is risky to FAIL.
 */
export class DangerousCompositePreset implements CompositeRerankPreset {
  readonly name = "dangerous";
  readonly description = "High-risk code: bug-prone, volatile, single-owner, heavily depended on";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    bugFix: 0.3,
    volatility: 0.2,
    knowledgeSilo: 0.15,
    fanIn: 0.15,
    burstActivity: 0.1,
    similarity: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "churnVolatility",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "blameContributorCount",
      "recentContributorCount",
      "ageDays",
      "imports",
      "relativeChurn",
      "codegraph.file.fanIn",
    ],
    chunk: [
      "commitCount",
      "churnRatio",
      "bugFixRate",
      "ageDays",
      "relativeChurn",
      "recentContributorCount",
      "blameContributorCount",
    ],
  };
}
