import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class RecencySignal implements DerivedSignalDescriptor {
  readonly name = "recency";
  readonly description = "Inverse of age: recently modified code scores higher. L3 blends chunk+file ageDays.";
  readonly sources = ["ageDays"];
  readonly defaultBound = 365;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 365;
    const effectiveAge = blendSignal(payload, "ageDays");
    return 1 - normalize(effectiveAge, b);
  }
}
