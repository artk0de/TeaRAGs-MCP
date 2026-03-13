import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

export class ChurnSignal implements DerivedSignalDescriptor {
  readonly name = "churn";
  readonly description =
    "Direct commit count: frequently changed code scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["file.commitCount", "chunk.commitCount"];
  readonly defaultBound = 50;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.commitCount"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "commitCount", fb, cb);
  }
}
