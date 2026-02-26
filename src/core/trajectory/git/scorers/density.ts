import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Change density signal: commits per month.
 * Higher = more frequent changes.
 */
export class DensityScorer implements Scorer {
  readonly name = "density";
  readonly description = "Change density — higher means more commits per month";
  readonly defaultBound = 20;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "changeDensity"), this.defaultBound);
  }
}
