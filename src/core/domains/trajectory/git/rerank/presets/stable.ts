import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Boost low-churn, long-lived, predictable code.
 *
 * Use when: looking for reliable implementations to reference or reuse,
 *   finding battle-tested patterns, avoiding volatile code.
 * Query examples: "utility functions", "core abstractions", "base classes".
 * Key signals: stability (few commits = mature), age (old = proven).
 *   Penalizes volatility (erratic = unreliable).
 * Available in search_code — simple preset for "find me code I can trust".
 * Inverse intent: TechDebtPreset surfaces the opposite — old + churning = debt.
 */
export class StablePreset implements RerankPreset {
  readonly name = "stable";
  readonly description = "Boost low-churn, long-lived, predictable code";
  readonly tools = ["search_code", "semantic_search", "hybrid_search", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    stability: 0.2,
    age: 0.15,
    volatility: -0.1,
    ownership: 0.05,
  };
  readonly overlayMask: OverlayMask = {
    file: ["commitCount", "ageDays", "churnVolatility", "dominantAuthorPct"],
    chunk: ["commitCount", "ageDays"],
  };
}
