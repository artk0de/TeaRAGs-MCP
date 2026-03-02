import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal } from "./helpers.js";

export class StabilitySignal implements DerivedSignalDescriptor {
  readonly name = "stability";
  readonly description =
    "Inverse of churn: stable code with few commits scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["commitCount"];
  readonly defaultBound = 50;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 50;
    const effectiveCC = blendSignal(rawSignals, "commitCount");
    return 1 - normalize(effectiveCC, b);
  }
}
