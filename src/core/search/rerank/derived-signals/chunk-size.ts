import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

export class ChunkSizeSignal implements DerivedSignalDescriptor {
  readonly name = "chunkSize";
  readonly description = "Normalized chunk size (endLine - startLine)";
  readonly sources: string[] = [];
  readonly defaultBound = 500;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 500;
    const start = (payload.startLine as number) || 0;
    const end = (payload.endLine as number) || 0;
    return normalize(Math.max(0, end - start), b);
  }
}
