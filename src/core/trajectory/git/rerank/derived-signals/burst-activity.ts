import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class BurstActivitySignal implements DerivedSignalDescriptor {
  readonly name = "burstActivity";
  readonly description = "Recency-weighted commit frequency. L3 blends chunk+file recencyWeightedFreq.";
  readonly sources = ["recencyWeightedFreq"];
  readonly defaultBound = 10.0;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 10.0;
    const effectiveBurst = blendSignal(payload, "recencyWeightedFreq");
    return normalize(effectiveBurst, b);
  }
}
