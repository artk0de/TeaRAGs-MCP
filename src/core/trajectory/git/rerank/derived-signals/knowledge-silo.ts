import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class KnowledgeSiloSignal implements DerivedSignalDescriptor {
  readonly name = "knowledgeSilo";
  readonly description = "Knowledge silo risk: 1 contributor=1.0, 2=0.5, 3+=0. L3 blends effective contributorCount.";
  readonly sources = ["contributorCount"];
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(payload: Record<string, unknown>): number {
    const effectiveCount = blendSignal(payload, "contributorCount");
    if (effectiveCount <= 0) return 0;
    if (effectiveCount === 1) return 1.0;
    if (effectiveCount === 2) return 0.5;
    return 0;
  }
}
