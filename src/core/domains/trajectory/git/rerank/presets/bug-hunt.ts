import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface code areas where bugs are likely hiding.
 *
 * Combines multiple instability indicators: recent burst of activity (someone
 * is actively fixing something), erratic commit patterns (panic-driven changes),
 * high relative churn (small file changed too often), and historical bug fix rate.
 *
 * Best used with queries describing symptoms or problem areas:
 *   "error handling in payment flow", "race condition", "null pointer".
 *
 * Compare: HotspotsPreset focuses on chunk-level churn metrics;
 *   BugHuntPreset emphasizes temporal patterns (bursts, volatility) and
 *   bug fix history over raw commit counts.
 */
export class BugHuntPreset implements RerankPreset {
  readonly name = "bugHunt";
  readonly description =
    "Find potential bug hiding spots: burst activity, volatility, high relative churn, and bug fix history";
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    burstActivity: 0.2,
    volatility: 0.2,
    relativeChurnNorm: 0.15,
    bugFix: 0.15,
    recency: 0.05,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["bugFixRate", "churnVolatility", "recencyWeightedFreq", "relativeChurn", "ageDays"],
    chunk: ["commitCount", "churnRatio"],
  };
}
