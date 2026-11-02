import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface frequently-changing code areas at chunk granularity: methods/blocks
 * with high commit density, recent activity bursts, and erratic timing.
 *
 * Use when: "which methods inside this file are churning", "where is recent
 *   commit activity concentrated at the chunk level", "what's been edited
 *   most often around this query".
 * Query examples: "validation logic", "request handlers", "scheduler".
 * Key signals: chunkChurn (~40%) + chunkRelativeChurn (~15%, the chunk's share
 *   of file churn), bugFix (~10%, tiebreaker between equally churning chunks;
 *   NOT a bug-history lens — for that use BugHuntPreset), relativeChurnNorm
 *   (~5%). Calibrated by a chunk-level backtest against future bug-fix commits
 *   (90/180-day splits): burstActivity and volatility carried no out-of-fold
 *   signal and were dropped.
 * Compare: both presets weigh churn; they differ in granularity.
 *   HotspotsPreset weighs chunk-scoped churn (`chunkChurn`,
 *   `chunkRelativeChurn`) — finds the problem method inside a file.
 *   BugHuntPreset weighs blended commit churn, bug-fix history and change
 *   density, calibrated against future bug-fix commits — finds the problem
 *   file.
 */
export class HotspotsPreset implements RerankPreset {
  readonly name = "hotspots";
  readonly filter = { presets: "production" } as const;
  readonly description =
    "Surface frequently-changing code areas (chunk-level churn and its share of file churn, bug-fix history)";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    chunkSize: 0.1,
    chunkChurn: 0.4,
    chunkRelativeChurn: 0.15,
    bugFix: 0.1,
    relativeChurnNorm: 0.05,
    blockPenalty: -0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "commitCount",
      "ageDays",
      "relativeChurn",
      "imports",
      "recentDominantAuthorPct",
      "blameDominantAuthorPct",
      "recentContributorCount",
    ],
    chunk: ["commitCount", "churnRatio", "bugFixRate", "ageDays", "relativeChurn", "recentContributorCount"],
  };
}
