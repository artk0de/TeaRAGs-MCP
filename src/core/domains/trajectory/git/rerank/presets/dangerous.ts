import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface high-risk code: bug-prone, volatile, single-owner.
 *
 * Use when: assessing dangerous zones, finding bus-factor risks,
 *   identifying code that combines multiple failure signals.
 * Query examples: "critical business logic", "payment processing", "auth".
 * Key signals: bugFix (dominant — historical bug fix rate), volatility
 *   (erratic commit patterns), knowledgeSilo (single contributor = bus factor),
 *   burstActivity (recent spike of changes).
 * Compare: BugHuntPreset emphasizes temporal patterns (bursts, relative churn);
 *   DangerousPreset emphasizes ownership risk (knowledgeSilo) combined with
 *   bug history (bugFix at 0.35 — highest weight among all presets).
 */
export class DangerousPreset implements RerankPreset {
  readonly name = "dangerous";
  readonly description = "Surface high-risk code: bug-prone, volatile, single-owner";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "rank_chunks"];
  readonly weights: ScoringWeights = {
    bugFix: 0.35,
    volatility: 0.25,
    knowledgeSilo: 0.2,
    burstActivity: 0.1,
    similarity: 0.1,
    blockPenalty: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["bugFixRate", "churnVolatility", "dominantAuthorPct", "contributorCount"],
    chunk: ["commitCount", "churnRatio", "bugFixRate"],
  };
}
