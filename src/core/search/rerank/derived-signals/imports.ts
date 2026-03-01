import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

export class ImportsSignal implements DerivedSignalDescriptor {
  readonly name = "imports";
  readonly description = "Normalized import/dependency count";
  readonly sources: string[] = [];
  readonly defaultBound = 20;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 20;
    const arr = payload.imports;
    return normalize(Array.isArray(arr) ? arr.length : 0, b);
  }
}
