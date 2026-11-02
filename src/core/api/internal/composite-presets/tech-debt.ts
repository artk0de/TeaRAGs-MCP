import {
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  type CompositeRerankPreset,
  type OverlayMask,
  type ScoringWeights,
} from "../../../contracts/index.js";

/**
 * Composite override for `techDebt` — old + churning code that's ALSO
 * heavily depended on (high fanIn) is real architectural debt. Git terms are
 * the trajectory preset's backtest-calibrated weights scaled to 0.72; fanIn
 * is uncalibrated and unchanged.
 */
export class TechDebtCompositePreset implements CompositeRerankPreset {
  readonly name = "techDebt";
  readonly filter = { presets: "production" } as const;
  readonly description = "Legacy code with high churn, bug rate, and architectural blast radius";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar", "trace_path"];
  readonly requires = [CODEGRAPH_SYMBOLS_PROVIDER_KEY, "git"] as const;
  readonly weights: ScoringWeights = {
    similarity: 0.13,
    age: 0.14,
    chunkChurn: 0.27,
    burstActivity: 0.18,
    bugFix: 0.04,
    chunkRelativeChurn: 0.05,
    relativeChurnNorm: 0.04,
    fanIn: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "ageDays",
      "commitCount",
      "bugFixRate",
      "recencyWeightedFreq",
      "relativeChurn",
      "imports",
      "blameDominantAuthorPct",
      "recentDominantAuthorPct",
      "recentContributorCount",
      "codegraph.file.fanIn",
    ],
    chunk: ["commitCount", "churnRatio", "ageDays", "bugFixRate", "relativeChurn", "blameDominantAuthorPct"],
  };
}
