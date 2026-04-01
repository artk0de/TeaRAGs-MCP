import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Heading-aware documentation ranking.
 *
 * Use when: searching documentation with language:"markdown" or documentation:"only".
 * Auto-activated by ExploreFacade when no explicit rerank is specified.
 * Key signals: similarity (0.5), headingRelevance (0.3), documentation (0.2).
 * headingRelevance is internal — excluded from overlay.
 */
export class DocumentationRelevancePreset implements RerankPreset {
  readonly name = "documentationRelevance";
  readonly description = "Boost documentation by heading relevance and depth";
  readonly tools = ["semantic_search", "hybrid_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    headingRelevance: 0.3,
    documentation: 0.2,
  };
  readonly overlayMask: OverlayMask = {};
}
