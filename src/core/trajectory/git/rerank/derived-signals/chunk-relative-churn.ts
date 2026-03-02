import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

export class ChunkRelativeChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkRelativeChurn";
  readonly description = "Chunk churn ratio: chunk's share of file-level churn, dampened by alpha.";
  readonly sources = ["chunk.churnRatio"];
  readonly defaultBound = 1.0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 1.0;
    const chunkCR = chunkNum(rawSignals, "churnRatio");
    const alpha = payloadAlpha(rawSignals);
    return normalize(chunkCR, b) * alpha;
  }
}
