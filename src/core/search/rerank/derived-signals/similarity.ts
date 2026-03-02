import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

export class SimilaritySignal implements DerivedSignalDescriptor {
  readonly name = "similarity";
  readonly description = "Base semantic similarity score from vector search";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    return (rawSignals._score as number) ?? (rawSignals.score as number) ?? 0;
  }
}
