import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../contracts/types/reranker.js";

export class SecurityAuditPreset implements RerankPreset {
  readonly name = "securityAudit";
  readonly description = "Old code in security-critical paths needing review";
  readonly tools = ["semantic_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.15,
    pathRisk: 0.15,
    volatility: 0.15,
  };
  readonly overlayMask: OverlayMask = {
    file: ["ageDays", "dominantAuthorPct", "bugFixRate", "churnVolatility"],
  };
}
