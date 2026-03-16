import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

/**
 * Chunk's share of the total file churn, weighted by alpha confidence.
 *
 * Purpose: find which chunk inside a file attracts most of the changes.
 * Detects: intra-file hotspots — the one function that gets 80% of all file commits.
 * Scoring: normalize(chunk.churnRatio) × alpha. churnRatio = chunk commits / file commits.
 *   Returns 0 when chunk data is absent.
 * Compare: RelativeChurnNormSignal normalizes by file size (LOC); this normalizes by
 *   commit count ratio within the file.
 */
export class ChunkRelativeChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkRelativeChurn";
  readonly description = "Chunk churn ratio: chunk's share of file-level churn, dampened by alpha.";
  readonly sources = ["chunk.churnRatio", "file.commitCount"];
  readonly defaultBound = 1.0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bounds?.["chunk.churnRatio"] ?? this.defaultBound;
    const chunkCR = chunkNum(rawSignals, "churnRatio");
    const alpha = payloadAlpha(rawSignals, ctx?.signalLevel);
    return normalize(chunkCR, b) * alpha;
  }
}
