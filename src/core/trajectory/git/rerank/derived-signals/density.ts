import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class DensitySignal implements DerivedSignalDescriptor {
  readonly name = "density";
  readonly description = "Change density: commits per month. L3 blends chunk+file changeDensity.";
  readonly sources = ["changeDensity"];
  readonly defaultBound = 20;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 20;
    const effectiveDensity = blendSignal(payload, "changeDensity");
    return normalize(effectiveDensity, b);
  }
}
