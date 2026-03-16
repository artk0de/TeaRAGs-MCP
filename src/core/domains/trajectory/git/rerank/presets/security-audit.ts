import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

/**
 * Surface old code in security-critical paths needing review.
 *
 * Use when: conducting security audits, reviewing auth/crypto code,
 *   checking for stale security implementations, compliance reviews.
 * Query examples: "authentication", "password hashing", "token validation".
 * Key signals: age (old = potentially outdated security practices),
 *   pathRisk (auth/crypto/secret paths), volatility (unstable security code),
 *   ownership (single author = less reviewed), bugFix (error-prone security code).
 * SignalLevel: file — security concerns are typically file-scoped.
 */
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
