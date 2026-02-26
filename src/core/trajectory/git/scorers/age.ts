import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Age signal: directly proportional to days since last change.
 * 0 = just modified, 1 = 1 year+ old.
 */
export class AgeScorer implements Scorer {
  readonly name = "age";
  readonly description = "Normalized file age — higher means older code";
  readonly defaultBound = 365;

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "ageDays"), this.defaultBound);
  }
}
