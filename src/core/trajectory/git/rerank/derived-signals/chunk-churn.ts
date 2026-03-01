import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

export class ChunkChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkChurn";
  readonly description = "Chunk-level commit count, dampened by alpha (coverage confidence).";
  readonly sources = ["chunk.commitCount"];
  readonly defaultBound = 30;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 30;
    const chunkCC = chunkNum(payload, "commitCount");
    const alpha = payloadAlpha(payload);
    return normalize(chunkCC, b) * alpha;
  }
}
