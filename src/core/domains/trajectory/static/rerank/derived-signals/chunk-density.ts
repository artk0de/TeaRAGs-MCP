import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

export class ChunkDensitySignal implements DerivedSignalDescriptor {
  readonly name = "chunkDensity";
  readonly description = "Code density: characters per line (from methodDensity payload field)";
  readonly sources = ["methodDensity", "methodLines"];
  readonly defaultBound = 120;

  /** Absolute minimum method size to consider density meaningful. */
  private readonly sizeFloor = 20;

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0) return 0; // density meaningless without a method/function

    // Adaptive threshold: max(floor, p50(methodLines)) from collection stats
    const p50 = ctx?.collectionStats?.perSignal.get("methodLines")?.percentiles?.[50] ?? 0;
    const sizeThreshold = Math.max(this.sizeFloor, p50);
    if (methodLines < sizeThreshold) return 0; // below-median methods — density irrelevant

    const methodDensity = (rawSignals.methodDensity as number) || 0;
    if (methodDensity <= 0) return 0;
    const bound = ctx?.bounds?.["methodDensity"] ?? this.defaultBound;
    return normalize(methodDensity, bound);
  }
}
