import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface high-risk code: bug-prone, churning, recently active, single-owner.
 *
 * Weights calibrated 2026-11-01 by a history backtest: signals at T-90d predict
 * the files that receive a bug-fix commit in (T-90d, T]. Two corpora (a
 * 205-author Rails monolith and this repo), label windows of 90 and 180 days.
 * Bug-fix history and commit churn carry most of the signal; volatility was
 * redundant with churn and dropped. knowledgeSilo stays at 0.1 as a DESIGN
 * term: bus-factor risk is part of what "dangerous" means, although the
 * backtest shows it does not predict fixes consistently (opposite sign on the
 * two corpora). Limit: the backtest is file-level while the preset runs at
 * chunk level (alpha-blend).
 *
 * Use when: assessing dangerous zones, finding bus-factor risks,
 *   identifying code that combines multiple failure signals.
 * Query examples: "critical business logic", "payment processing", "auth".
 * Key signals: bugFix (highest weight — historical bug fix rate), churn,
 *   density, recency, knowledgeSilo (single contributor = bus factor),
 *   burstActivity (recent spike of changes).
 * Compare: BugHuntPreset leads with commit churn to predict future bug fixes;
 *   DangerousPreset leads with bug history and keeps ownership risk
 *   (knowledgeSilo) in the mix.
 */
export class DangerousPreset implements RerankPreset {
  readonly name = "dangerous";
  readonly filter = { presets: "production" } as const;
  readonly description = "Surface high-risk code: bug-prone, churning, recently active, single-owner";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks"];
  readonly weights: ScoringWeights = {
    bugFix: 0.25,
    churn: 0.2,
    density: 0.15,
    recency: 0.15,
    knowledgeSilo: 0.1,
    burstActivity: 0.05,
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
