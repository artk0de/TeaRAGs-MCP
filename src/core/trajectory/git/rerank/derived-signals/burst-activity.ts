import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal } from "./helpers.js";

export class BurstActivitySignal implements DerivedSignalDescriptor {
  readonly name = "burstActivity";
  readonly description = "Recency-weighted commit frequency. L3 blends chunk+file recencyWeightedFreq.";
  readonly sources = ["recencyWeightedFreq"];
  readonly defaultBound = 10.0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 10.0;
    const effectiveBurst = blendSignal(rawSignals, "recencyWeightedFreq");
    return normalize(effectiveBurst, b);
  }
}
