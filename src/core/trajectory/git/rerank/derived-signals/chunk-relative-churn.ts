import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

export class ChunkRelativeChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkRelativeChurn";
  readonly description = "Chunk churn ratio: chunk's share of file-level churn, dampened by alpha.";
  readonly sources = ["chunk.churnRatio"];
  readonly defaultBound = 1.0;
  extract(payload: Record<string, unknown>, bound?: number): number {
    const b = bound ?? 1.0;
    const chunkCR = chunkNum(payload, "churnRatio");
    const alpha = payloadAlpha(payload);
    return normalize(chunkCR, b) * alpha;
  }
}
