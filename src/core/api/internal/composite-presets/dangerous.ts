import {
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  type CompositeRerankPreset,
  type OverlayMask,
  type ScoringWeights,
  type SignalLevel,
} from "../../../contracts/index.js";

/**
 * Composite override for `dangerous` — adds blast-radius (fanIn) so
 * bug-prone + single-owner code that's ALSO heavily depended on bubbles
 * to the top. Pure git signal without fanIn told you which code is
 * risky to TOUCH; adding fanIn tells you which is risky to FAIL.
 *
 * History terms are the calibrated `DangerousPreset` weights (backtest
 * 2026-11-01) scaled to 0.75; volatility dropped as redundant with churn.
 * fanIn stays unchanged: it is not calibrated (no historical graph to
 * backtest against).
 */
export class DangerousCompositePreset implements CompositeRerankPreset {
  readonly name = "dangerous";
  readonly filter = { presets: "production" } as const;
  readonly signalLevel: SignalLevel = "file";
  readonly description = "High-risk code: bug-prone, churning, recently active, single-owner, heavily depended on";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks", "trace_path"];
  readonly requires = [CODEGRAPH_SYMBOLS_PROVIDER_KEY, "git"] as const;
  readonly weights: ScoringWeights = {
    bugFix: 0.21,
    churn: 0.17,
    recency: 0.13,
    density: 0.12,
    knowledgeSilo: 0.08,
    burstActivity: 0.04,
    fanIn: 0.15,
    similarity: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "commitCount",
      "changeDensity",
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
