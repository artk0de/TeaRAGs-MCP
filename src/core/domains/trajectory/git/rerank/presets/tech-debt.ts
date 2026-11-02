import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Surface legacy code accumulating technical debt.
 *
 * Use when: assessing code health, planning modernization, prioritizing cleanup,
 *   or identifying areas that slow down development.
 * Query examples: "core business logic", "data processing pipeline".
 * Key signals: age (old code, held at 15%), chunkChurn (~30%) + burstActivity
 *   (~20%) — old code that keeps attracting changes — plus bugFix,
 *   chunkRelativeChurn and relativeChurnNorm (5% each). Calibrated by a
 *   chunk-level backtest against future bug-fix commits (90/180-day splits)
 *   with age constrained to keep the legacy lens: age alone predicts fewer
 *   future fixes, and knowledgeSilo, volatility and density carried no signal.
 * Works well with rank_chunks for project-wide tech debt inventory without a query.
 */
export class TechDebtPreset implements RerankPreset {
  readonly name = "techDebt";
  readonly filter = { presets: "production" } as const;
  readonly description = "Find legacy code that keeps attracting changes: old, churning chunks with recent bursts";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.15,
    age: 0.15,
    chunkChurn: 0.3,
    burstActivity: 0.2,
    bugFix: 0.05,
    chunkRelativeChurn: 0.05,
    relativeChurnNorm: 0.05,
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
    ],
    chunk: ["commitCount", "churnRatio", "ageDays", "bugFixRate", "relativeChurn", "blameDominantAuthorPct"],
  };
}
