import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Burst activity signal: recency-weighted commit frequency.
 * Higher = more recent activity burst.
 */
export class BurstActivityScorer implements Scorer {
  readonly name = "burstActivity";
  readonly description = "Recency-weighted frequency — higher means recent burst of changes";
  readonly defaultBound = 10.0;

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "recencyWeightedFreq"), this.defaultBound);
  }
}
