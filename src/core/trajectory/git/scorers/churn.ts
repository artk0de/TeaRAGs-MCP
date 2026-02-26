import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Churn signal: directly proportional to commit count.
 * 0 = untouched, 1 = 50+ commits.
 */
export class ChurnScorer implements Scorer {
  readonly name = "churn";
  readonly description = "Normalized commit count — higher means more changes";
  readonly defaultBound = 50;

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "commitCount"), this.defaultBound);
  }
}
