import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class HotspotsPreset implements RerankPreset {
  readonly name = "hotspots";
  readonly description = "Identify frequently-changing bug-prone code areas";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.15,
    burstActivity: 0.15,
    bugFix: 0.15,
    volatility: 0.15,
    blockPenalty: -0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: ["bugFixRate", "churnVolatility", "recencyWeightedFreq"],
    chunk: ["commitCount", "churnRatio"],
  };
}
