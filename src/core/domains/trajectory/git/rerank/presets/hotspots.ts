import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Identify frequently-changing, bug-prone code hotspots.
 *
 * Use when: investigating recurring bugs, finding areas that break often,
 *   or identifying chunks that attract constant fixes.
 * Query examples: "error handling", "database queries", "validation logic".
 * Key signals: chunkChurn + chunkRelativeChurn (chunk-level commit activity),
 *   burstActivity (recent spike), volatility (erratic timing), bugFix (fix history).
 * Compare: BugHuntPreset emphasizes temporal patterns (bursts, volatility);
 *   HotspotsPreset leans on chunk-level churn metrics for intra-file hotspots.
 */
export class HotspotsPreset implements RerankPreset {
  readonly name = "hotspots";
  readonly description = "Identify frequently-changing bug-prone code areas";
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
    file: ["bugFixRate", "churnVolatility", "recencyWeightedFreq"],
    chunk: ["commitCount", "churnRatio"],
  };
}
