import type { ScoringWeights } from "../../../../contracts/types/provider.js";
import type { CompositeRerankPreset, OverlayMask, SignalLevel } from "../../../../contracts/types/reranker.js";

/**
 * Composite override for `securityAudit` — auth/crypto files imported
 * by many places (high fanIn) are more attractive attack surfaces and
 * deserve audit priority over equally-old isolated utilities. Shin 2010
 * links CCC + complexity ↔ vulnerability; fanIn approximates the
 * "imported by" half until complexity signals land.
 */
export class SecurityAuditCompositePreset implements CompositeRerankPreset {
  readonly name = "securityAudit";
  readonly description = "Old security-critical paths with high blast radius (audit priority targets)";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "find_similar", "trace_path"];
  readonly requires = ["codegraph.symbols", "git"] as const;
  // chunkChurn dropped (signalLevel "file" → payloadAlpha 0 → always-0 dead
  // weight). Mirrors the git securityAudit redistribution: bugFix +0.05,
  // volatility +0.05; fanIn (the composite's blast-radius axis) stays 0.1.
  readonly weights: ScoringWeights = {
    similarity: 0.2,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.15,
    pathRisk: 0.15,
    volatility: 0.15,
    fanIn: 0.1,
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
      "codegraph.file.fanIn",
    ],
    chunk: ["commitCount", "bugFixRate"],
  };
}
