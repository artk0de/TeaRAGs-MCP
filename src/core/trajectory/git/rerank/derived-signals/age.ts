import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class AgeSignal implements DerivedSignalDescriptor {
  readonly name = "age";
  readonly description = "Direct age: older code scores higher. L3 blends chunk+file ageDays.";
  readonly sources = ["ageDays"];
  readonly defaultBound = 365;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 365;
    const effectiveAge = blendSignal(payload, "ageDays");
    return normalize(effectiveAge, b);
  }
}
