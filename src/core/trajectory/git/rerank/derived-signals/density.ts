import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal } from "./helpers.js";

export class DensitySignal implements DerivedSignalDescriptor {
  readonly name = "density";
  readonly description = "Change density: commits per month. L3 blends chunk+file changeDensity.";
  readonly sources = ["changeDensity"];
  readonly defaultBound = 20;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 20;
    const effectiveDensity = blendSignal(rawSignals, "changeDensity");
    return normalize(effectiveDensity, b);
  }
}
