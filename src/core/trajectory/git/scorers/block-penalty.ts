import type { Scorer } from "../../../api/scorer.js";
import { hasChunkField } from "./_helpers.js";

/**
 * Block penalty signal: detects block chunks with only file-level data.
 * Returns 1.0 for block chunks lacking chunk-level git data (penalty target),
 * 0.0 otherwise.
 */
export class BlockPenaltyScorer implements Scorer {
  readonly name = "blockPenalty";
  readonly description = "Penalty for block chunks without chunk-level git data";

  extract(payload: Record<string, unknown>): number {
    const { chunkType } = payload;
    if (chunkType !== "block") return 0;
    // Block with chunk-level commitCount is fine
    if (hasChunkField(payload, "commitCount")) return 0;
    return 1.0;
  }
}
