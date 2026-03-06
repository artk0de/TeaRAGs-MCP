import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

export class ChunkDensitySignal implements DerivedSignalDescriptor {
  readonly name = "chunkDensity";
  readonly description = "Code density: characters per line (contentSize / lines)";
  readonly sources: string[] = [];
  readonly defaultBound = 0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const contentSize = (rawSignals.contentSize as number) || 0;
    const start = (rawSignals.startLine as number) || 0;
    const end = (rawSignals.endLine as number) || 0;
    const lines = end - start;
    if (lines <= 0 || contentSize <= 0) return 0;
    const density = contentSize / lines;
    const bound = ctx?.bounds?.[this.name] ?? this.defaultBound;
    return bound > 0 ? normalize(density, bound) : density;
  }
}
