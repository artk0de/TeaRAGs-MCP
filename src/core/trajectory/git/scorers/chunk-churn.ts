import type { Scorer } from "../../../api/scorer.js";
import { chunkNum, normalize } from "./_helpers.js";

/**
 * Chunk-level churn signal: commits touching this specific chunk.
 * Uses chunk.commitCount normalized to 30.
 */
export class ChunkChurnScorer implements Scorer {
  readonly name = "chunkChurn";
  readonly description = "Chunk-level commit count — higher means more changes to this chunk";
  readonly defaultBound = 30;

  extract(payload: Record<string, unknown>): number {
    return normalize(chunkNum(payload, "commitCount"), this.defaultBound);
  }
}
