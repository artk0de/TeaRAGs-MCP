import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

export class KnowledgeSiloSignal implements DerivedSignalDescriptor {
  readonly name = "knowledgeSilo";
  readonly description = "Knowledge silo risk: 1 contributor=1.0, 2=0.5, 3+=0. L3 blends effective contributorCount.";
  readonly sources = ["file.contributorCount", "chunk.contributorCount"];
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const effectiveCount = blendSignal(rawSignals, "contributorCount");
    let value: number;
    if (effectiveCount <= 0) return 0;
    if (effectiveCount === 1) value = 1.0;
    else if (effectiveCount === 2) value = 0.5;
    else return 0;
    const k = ctx?.dampeningThreshold ?? KnowledgeSiloSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
