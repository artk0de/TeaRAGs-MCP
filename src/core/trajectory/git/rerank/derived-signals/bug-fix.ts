import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal } from "./helpers.js";

export class BugFixSignal implements DerivedSignalDescriptor {
  readonly name = "bugFix";
  readonly description = "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.";
  readonly sources = ["bugFixRate"];
  readonly defaultBound = 100;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 100;
    const effectiveBFR = blendSignal(rawSignals, "bugFixRate");
    return normalize(effectiveBFR, b);
  }
}
