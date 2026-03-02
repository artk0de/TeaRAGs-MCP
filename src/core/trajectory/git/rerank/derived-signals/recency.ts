import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal } from "./helpers.js";

export class RecencySignal implements DerivedSignalDescriptor {
  readonly name = "recency";
  readonly description = "Inverse of age: recently modified code scores higher. L3 blends chunk+file ageDays.";
  readonly sources = ["file.ageDays"];
  readonly defaultBound = 365;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 365;
    const effectiveAge = blendSignal(rawSignals, "ageDays");
    return 1 - normalize(effectiveAge, b);
  }
}
