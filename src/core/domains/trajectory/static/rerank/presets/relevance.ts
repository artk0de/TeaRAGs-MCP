import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../contracts/types/reranker.js";

/**
 * Pure semantic similarity ranking — no git or structural adjustments.
 *
 * Use when: you want the raw vector search order, trusting that the embedding
 *   model's relevance is sufficient. Default preset when no rerank is specified.
 * Query examples: any — this is the baseline for all search types.
 * Key signals: similarity only (weight 1.0). No overlay data.
 * Available in all tools including search_code.
 */
export class RelevancePreset implements RerankPreset {
  readonly name = "relevance";
  readonly description = "Pure semantic similarity ranking";
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar"];
  readonly weights: ScoringWeights = { similarity: 1.0 };
  readonly overlayMask: OverlayMask = {};
}
