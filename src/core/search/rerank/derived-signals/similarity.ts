import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

export class SimilaritySignal implements DerivedSignalDescriptor {
  readonly name = "similarity";
  readonly description = "Base semantic similarity score from vector search";
  readonly sources: string[] = [];
  extract(payload: Record<string, unknown>): number {
    return (payload._score as number) ?? (payload.score as number) ?? 0;
  }
}
