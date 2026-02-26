import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Recency signal: inversely proportional to age.
 * 1 = just modified, 0 = 1 year+ old.
 */
export class RecencyScorer implements Scorer {
  readonly name = "recency";
  readonly description = "Inverse of file age — higher means more recently modified";
  readonly defaultBound = 365;

  extract(payload: Record<string, unknown>): number {
    return 1 - normalize(fileNum(payload, "ageDays"), this.defaultBound);
  }
}
