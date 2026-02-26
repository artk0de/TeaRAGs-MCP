import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Stability signal: inversely proportional to commit count.
 * 1 = untouched, 0 = 50+ commits.
 */
export class StabilityScorer implements Scorer {
  readonly name = "stability";
  readonly description = "Inverse of commit count — higher means less churn";
  readonly defaultBound = 50;

  extract(payload: Record<string, unknown>): number {
    return 1 - normalize(fileNum(payload, "commitCount"), this.defaultBound);
  }
}
