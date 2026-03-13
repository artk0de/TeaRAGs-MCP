import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

export class StabilitySignal implements DerivedSignalDescriptor {
  readonly name = "stability";
  readonly description =
    "Inverse of churn: stable code with few commits scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["file.commitCount", "chunk.commitCount"];
  readonly defaultBound = 50;
  readonly inverted = true as const;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.commitCount"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    return 1 - blendNormalized(rawSignals, "commitCount", fb, cb);
  }
}
