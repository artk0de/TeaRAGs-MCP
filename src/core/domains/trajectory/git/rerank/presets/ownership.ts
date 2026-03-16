import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset, SignalLevel } from "../../../../../contracts/types/reranker.js";

/**
 * Find code with concentrated ownership — knowledge transfer risks.
 *
 * Use when: planning knowledge sharing, preparing for team changes,
 *   identifying bus factor risks, assigning reviewers.
 * Query examples: "authentication service", "billing module".
 * Key signals: ownership (dominant author percentage), knowledgeSilo
 *   (1-2 contributors = high risk).
 * SignalLevel: file — ownership is a file-level concept.
 */
export class OwnershipPreset implements RerankPreset {
  readonly name = "ownership";
  readonly description = "Code with single dominant author — knowledge transfer risk";
  readonly signalLevel: SignalLevel = "file";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = { similarity: 0.35, ownership: 0.3, knowledgeSilo: 0.25, chunkChurn: 0.1 };
  readonly overlayMask: OverlayMask = {
    file: ["dominantAuthorPct", "contributorCount"],
    chunk: ["contributorCount", "commitCount"],
  };
}
