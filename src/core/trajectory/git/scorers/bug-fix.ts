import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

/**
 * Bug fix rate signal: percentage of commits with fix/bug keywords.
 * 0 = no fixes, 1 = all commits are fixes.
 */
export class BugFixScorer implements Scorer {
  readonly name = "bugFix";
  readonly description = "Normalized bug fix rate — higher means more fix commits";
  readonly defaultBound = 100;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    return normalize(fileNum(payload, "bugFixRate"), this.defaultBound);
  }
}
