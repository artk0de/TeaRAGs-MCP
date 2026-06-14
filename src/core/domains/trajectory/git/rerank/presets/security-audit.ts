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
  // chunkChurn dropped: signalLevel "file" forces payloadAlpha 0, so chunkChurn
  // always scored 0 yet its 0.1 weight diluted every real signal by ~10%. Its
  // budget moved to the process-metric axis (bugFix +0.05, volatility +0.05).
  readonly weights: ScoringWeights = {
    similarity: 0.25,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.15,
    pathRisk: 0.15,
    volatility: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    file: [
      "ageDays",
      "recentDominantAuthorPct",
      "recentContributorCount",
      "blameDominantAuthorPct",
      "blameContributorCount",
      "bugFixRate",
      "churnVolatility",
    ],
    chunk: ["commitCount", "bugFixRate"],
  };
}
