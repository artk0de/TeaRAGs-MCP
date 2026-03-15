import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

export class SecurityAuditPreset implements RerankPreset {
  readonly name = "securityAudit";
  readonly description = "Old code in security-critical paths needing review";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar"];
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.1,
    chunkChurn: 0.1,
    pathRisk: 0.15,
    volatility: 0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "dominantAuthorPct", "bugFixRate", "churnVolatility"],
    chunk: ["commitCount", "bugFixRate"],
  };
}
