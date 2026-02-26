import type { Scorer } from "../../../api/scorer.js";
import { chunkNum, fileNum, hasChunkField } from "./_helpers.js";

/**
 * Knowledge silo signal: categorical risk based on contributor count.
 * 1 contributor = 1.0 (high silo risk), 2 = 0.5, 3+ = 0.
 * Prefers chunk-level contributorCount when available.
 */
export class KnowledgeSiloScorer implements Scorer {
  readonly name = "knowledgeSilo";
  readonly description = "Knowledge silo risk — 1.0 for single contributor, 0.5 for two, 0 for three+";
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    const count = hasChunkField(payload, "contributorCount")
      ? chunkNum(payload, "contributorCount")
      : fileNum(payload, "contributorCount");

    if (count <= 0) return 0;
    if (count === 1) return 1.0;
    if (count === 2) return 0.5;
    return 0;
  }
}
