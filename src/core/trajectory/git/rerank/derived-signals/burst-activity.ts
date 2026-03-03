import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

export class BurstActivitySignal implements DerivedSignalDescriptor {
  readonly name = "burstActivity";
  readonly description = "Recency-weighted commit frequency. L3 blends chunk+file recencyWeightedFreq.";
  readonly sources = ["file.recencyWeightedFreq", "chunk.recencyWeightedFreq"];
  readonly defaultBound = 10.0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.recencyWeightedFreq"] ?? 10.0;
    const cb = ctx?.bounds?.["chunk.recencyWeightedFreq"] ?? 10.0;
    return blendNormalized(rawSignals, "recencyWeightedFreq", fb, cb);
  }
}
