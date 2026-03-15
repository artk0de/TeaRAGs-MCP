import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

export class ImportsSignal implements DerivedSignalDescriptor {
  readonly name = "imports";
  readonly description = "Normalized import/dependency count";
  readonly sources: string[] = [];
  readonly defaultBound = 20;
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const arr = rawSignals.imports;
    return normalize(Array.isArray(arr) ? arr.length : 0, this.defaultBound);
  }
}
