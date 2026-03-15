import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

export class ChunkSizeSignal implements DerivedSignalDescriptor {
  readonly name = "chunkSize";
  readonly description = "Normalized method/block size in lines (from methodLines payload field)";
  readonly sources = ["methodLines"];
  readonly defaultBound = 500;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0) return 0;
    const bound = ctx?.bounds?.["methodLines"] ?? this.defaultBound;
    return normalize(methodLines, bound);
  }
}
