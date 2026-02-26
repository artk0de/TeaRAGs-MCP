import type { Scorer } from "../../../api/scorer.js";
import { fileField } from "./_helpers.js";

/**
 * Ownership signal: author concentration.
 * Uses dominantAuthorPct (0-100) when available, else 1/authors.length.
 * Higher = more concentrated ownership.
 */
export class OwnershipScorer implements Scorer {
  readonly name = "ownership";
  readonly description = "Author concentration — higher means more focused ownership";
  readonly defaultBound = 100;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";

  extract(payload: Record<string, unknown>): number {
    const pct = fileField(payload, "dominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      return pct / 100;
    }
    const authors = fileField(payload, "authors") as string[] | undefined;
    if (!authors || !Array.isArray(authors) || authors.length === 0) return 0;
    if (authors.length === 1) return 1;
    return 1 / authors.length;
  }
}
