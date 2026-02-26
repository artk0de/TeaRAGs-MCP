import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Relative churn signal: (linesAdded + linesDeleted) / currentLines.
 * Higher = more code turnover relative to file size.
 */
export class RelativeChurnScorer implements Scorer {
  readonly name = "relativeChurnNorm";
  readonly description = "Relative churn — higher means more turnover relative to file size";
  readonly defaultBound = 5.0;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "relativeChurn"), this.defaultBound);
  }
}
