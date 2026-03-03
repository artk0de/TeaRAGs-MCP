import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

export class ChunkSizeSignal implements DerivedSignalDescriptor {
  readonly name = "chunkSize";
  readonly description = "Normalized chunk size (endLine - startLine)";
  readonly sources: string[] = [];
  readonly defaultBound = 500;
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const start = (rawSignals.startLine as number) || 0;
    const end = (rawSignals.endLine as number) || 0;
    return normalize(Math.max(0, end - start), this.defaultBound);
  }
}
