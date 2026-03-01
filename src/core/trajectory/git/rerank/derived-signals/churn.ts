import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { blendSignal } from "./helpers.js";

export class ChurnSignal implements DerivedSignalDescriptor {
  readonly name = "churn";
  readonly description =
    "Direct commit count: frequently changed code scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["commitCount"];
  readonly defaultBound = 50;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 50;
    const effectiveCC = blendSignal(payload, "commitCount");
    return normalize(effectiveCC, b);
  }
}
