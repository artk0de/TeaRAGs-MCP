import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Volatility signal: standard deviation of days between commits.
 * Higher = more erratic change pattern.
 */
export class VolatilityScorer implements Scorer {
  readonly name = "volatility";
  readonly description = "Churn volatility — higher means more erratic change patterns";
  readonly defaultBound = 60;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "churnVolatility"), this.defaultBound);
  }
}
