import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

export class OwnershipPreset implements RerankPreset {
  readonly name = "ownership";
  readonly description = "Code with single dominant author — knowledge transfer risk";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
  readonly weights: ScoringWeights = { similarity: 0.35, ownership: 0.3, knowledgeSilo: 0.25, chunkChurn: 0.1 };
  readonly overlayMask: OverlayMask = {
    file: ["dominantAuthorPct", "contributorCount"],
    chunk: ["contributorCount", "commitCount"],
  };
}
