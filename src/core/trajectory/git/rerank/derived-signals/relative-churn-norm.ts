import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class RelativeChurnNormSignal implements DerivedSignalDescriptor {
  readonly name = "relativeChurnNorm";
  readonly description = "Relative churn: total changes relative to file size. L3 blends chunk+file relativeChurn.";
  readonly sources = ["relativeChurn"];
  readonly defaultBound = 5.0;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 5.0;
    const effectiveRC = blendSignal(payload, "relativeChurn");
    return normalize(effectiveRC, b);
  }
}
