import type { Scorer } from "../../../api/scorer.js";
import { chunkNum, normalize } from "./_helpers.js";

/**
 * Chunk relative churn signal: chunk's share of file churn.
 * Uses chunk.churnRatio (already 0-1).
 */
export class ChunkRelativeChurnScorer implements Scorer {
  readonly name = "chunkRelativeChurn";
  readonly description = "Chunk churn ratio — chunk's proportion of total file churn";
  readonly defaultBound = 1.0;

  extract(payload: Record<string, unknown>): number {
    return normalize(chunkNum(payload, "churnRatio"), this.defaultBound);
  }
}
