import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

/**
 * Base vector similarity score from Qdrant search.
 *
 * Purpose: preserve semantic relevance as the foundation of all reranking.
 * Detects: nothing on its own — this is the baseline "how well does this chunk
 *   match the query?" score that other signals adjust.
 * Scoring: raw Qdrant score (cosine similarity), range [0, 1].
 * Used in: every preset — typically the dominant weight. Without similarity,
 *   reranking becomes pure metadata sorting unrelated to the query.
 */
export class SimilaritySignal implements DerivedSignalDescriptor {
  readonly name = "similarity";
  readonly description = "Base semantic similarity score from vector search";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    return (rawSignals._score as number) ?? (rawSignals.score as number) ?? 0;
  }
}
