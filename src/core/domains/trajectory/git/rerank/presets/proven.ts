import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

/**
 * Battle-tested code: long-lived, stable, low-bug, multi-author.
 *
 * Use when: finding reliable reference/template code for generation,
 *   identifying proven patterns worth copying, selecting trustworthy
 *   implementations as examples.
 * Query examples: "error handling patterns", "retry logic", "validation".
 * Key signals: stability (low churn = mature), age (old = proven).
 *   Penalizes bugFix (high bug-fix ratio = unreliable), knowledgeSilo
 *   (1-2 contributors = less peer-reviewed), volatility (erratic = risky).
 * Differs from StablePreset: similarity is demoted (0.2 vs 0.45) to
 *   heavily favor battle-tested signals over semantic match; signalLevel
 *   is "file" because proven-ness is a file-level property; knowledgeSilo
 *   is negative (≥3 contributors = many eyes = more trust). knowledgeSilo
 *   is preferred over `ownership` because it directly captures "few people
 *   touched this code" — `ownership` would also penalize a file legitimately
 *   touched by 5 people where one happens to dominate by line share.
 */
export class ProvenPreset implements RerankPreset {
  readonly name = "proven";
  readonly description =
    "Battle-tested code: long-lived, stable, low-bug, multi-author. Use for finding reliable reference/template code.";
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar", "trace_path"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    stability: 0.3,
    age: 0.3,
    bugFix: -0.15,
    knowledgeSilo: -0.1,
    volatility: -0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["bugFixRate", "ageDays", "commitCount", "blameContributorCount"],
  };
  readonly signalLevel: SignalLevel = "file";
}
