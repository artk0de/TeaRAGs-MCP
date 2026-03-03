import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

export class ChunkChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkChurn";
  readonly description = "Chunk-level commit count, dampened by alpha (coverage confidence).";
  readonly sources = ["chunk.commitCount", "file.commitCount"];
  readonly defaultBound = 30;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    const chunkCC = chunkNum(rawSignals, "commitCount");
    const alpha = payloadAlpha(rawSignals);
    return normalize(chunkCC, b) * alpha;
  }
}
