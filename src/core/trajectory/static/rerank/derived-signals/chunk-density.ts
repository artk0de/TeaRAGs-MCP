import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";

export class ChunkDensitySignal implements DerivedSignalDescriptor {
  readonly name = "chunkDensity";
  readonly description = "Code density: characters per line (from methodDensity payload field)";
  readonly sources = ["methodDensity"];
  readonly defaultBound = 120;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodDensity = (rawSignals.methodDensity as number) || 0;
    if (methodDensity <= 0) return 0;
    const bound = ctx?.bounds?.["methodDensity"] ?? this.defaultBound;
    return normalize(methodDensity, bound);
  }
}
