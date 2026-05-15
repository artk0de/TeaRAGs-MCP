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
 * Key signals: chunkChurn + chunkRelativeChurn (intra-file churn share, ~30%),
 *   burstActivity + volatility (recent timing pattern, ~30%),
 *   bugFix (~10%, minor — kept as historical tiebreaker between equally
 *   churning chunks; NOT a bug-history lens — for that use BugHuntPreset or
 *   custom rerank weights with high `bugFix`).
 * Compare: BugHuntPreset and HotspotsPreset overlap on temporal signals
 *   (burst, volatility); they differ in granularity. HotspotsPreset weighs
 *   chunk-scoped churn (`chunkChurn`, `chunkRelativeChurn`) — finds the
 *   problem method inside a file. BugHuntPreset weighs file-normalized
 *   churn (`relativeChurnNorm`) — finds the problem file.
 */
export class HotspotsPreset implements RerankPreset {
  readonly name = "hotspots";
  readonly description =
    "Surface frequently-changing code areas (chunk-level churn, burst activity, timing volatility)";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    chunkSize: 0.1,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.15,
    burstActivity: 0.15,
    bugFix: 0.1,
    volatility: 0.15,
    blockPenalty: -0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "bugFixRate",
      "churnVolatility",
      "recencyWeightedFreq",
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
