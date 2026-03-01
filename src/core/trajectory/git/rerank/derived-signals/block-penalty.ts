import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { hasChunkData, payloadAlpha } from "./helpers.js";

export class BlockPenaltySignal implements DerivedSignalDescriptor {
  readonly name = "blockPenalty";
  readonly description =
    "Data quality discount for block chunks: 1.0 if block without chunk data (alpha=0), 0 otherwise";
  readonly sources = ["chunk.commitCount", "commitCount"];
  extract(payload: Record<string, unknown>): number {
    const { chunkType } = payload;
    if (chunkType !== "block") return 0;
    // If chunk-level git data exists, compute alpha to determine penalty
    if (hasChunkData(payload)) {
      const alpha = payloadAlpha(payload);
      return 1.0 - alpha;
    }
    // No chunk data at all — full penalty
    return 1.0;
  }
}
