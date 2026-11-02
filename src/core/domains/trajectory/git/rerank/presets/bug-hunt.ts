import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

/**
 * Surface code areas where bugs are likely hiding.
 *
 * Weights calibrated 2026-11-01 by a git backtest: signals at T-90d predict
 * the files that receive a bug-fix commit in (T-90d, T]. Two corpora (a
 * 205-author Rails monolith and this repo), label windows of 90 and 180 days.
 * Commit churn and bug-fix history carry most of the signal; volatility and
 * relative churn were redundant with churn and were dropped. The backtest is
 * file-level, so the preset ranks at file level by default
 * (`signalLevel: "file"`, bd tea-rags-mcp-9z8ae); an explicit `level: "chunk"`
 * still overrides.
 *
 * Best used with queries describing symptoms or problem areas:
 *   "error handling in payment flow", "race condition", "null pointer".
 *
 * Compare: HotspotsPreset focuses on chunk-level churn metrics;
 *   BugHuntPreset adds bug fix history, change density and recency on top of
 *   commit churn, tuned to predict future bug-fix commits.
 */
export class BugHuntPreset implements RerankPreset {
  readonly name = "bugHunt";
  readonly filter = { presets: "production" } as const;
  readonly signalLevel: SignalLevel = "file";
  readonly description =
    "Find potential bug hiding spots: commit churn, bug fix history, change density, recency and burst activity";
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar", "rank_chunks", "trace_path"];
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    churn: 0.25,
    bugFix: 0.2,
    density: 0.15,
    recency: 0.1,
    burstActivity: 0.05,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "commitCount",
      "changeDensity",
      "churnVolatility",
      "recencyWeightedFreq",
      "relativeChurn",
      "ageDays",
      "imports",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "recentContributorCount",
    ],
    chunk: ["commitCount", "churnRatio", "bugFixRate", "ageDays", "relativeChurn", "recentContributorCount"],
  };
}
