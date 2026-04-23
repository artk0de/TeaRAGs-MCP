import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface legacy code accumulating technical debt.
 *
 * Use when: assessing code health, planning modernization, prioritizing cleanup,
 *   or identifying areas that slow down development.
 * Query examples: "core business logic", "data processing pipeline".
 * Key signals: age (old code), churn (frequently patched), bugFix (error-prone),
 *   knowledgeSilo (single contributor), volatility (erratic changes).
 * Works well with rank_chunks for project-wide tech debt inventory without a query.
 */
export class TechDebtPreset implements RerankPreset {
  readonly name = "techDebt";
  readonly description = "Find legacy code with high churn, old age, and frequent bug fixes";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.15,
    age: 0.15,
    churn: 0.1,
    chunkChurn: 0.1,
    bugFix: 0.15,
    volatility: 0.1,
    knowledgeSilo: 0.1,
    density: 0.1,
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
      "dominantAuthorPct",
      "contributorCount",
    ],
    chunk: ["commitCount", "churnRatio", "ageDays", "bugFixRate", "relativeChurn"],
  };
}
