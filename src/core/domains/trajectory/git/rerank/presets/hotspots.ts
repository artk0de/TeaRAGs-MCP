import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

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
