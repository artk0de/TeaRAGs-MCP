import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `techDebt` — old + churning code that's ALSO
 * heavily depended on (high fanIn) is real architectural debt; the
 * trajectory preset alone scored "old + churning + sole owner" without
 * knowing whether anyone consumes it.
 */
export class TechDebtCompositePreset implements CompositeRerankPreset {
  readonly name = "techDebt";
  readonly description = "Legacy code with high churn, bug rate, and architectural blast radius";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.13,
    age: 0.15,
    churn: 0.1,
    chunkChurn: 0.1,
    bugFix: 0.15,
    volatility: 0.1,
    knowledgeSilo: 0.07,
    density: 0.05,
    fanIn: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "ageDays",
      "commitCount",
      "bugFixRate",
      "churnVolatility",
      "changeDensity",
      "imports",
      "blameDominantAuthorPct",
      "blameContributorCount",
      "recentDominantAuthorPct",
      "recentContributorCount",
      "codegraph.file.fanIn",
    ],
    chunk: ["commitCount", "churnRatio", "ageDays", "bugFixRate", "relativeChurn", "blameDominantAuthorPct"],
  };
}
