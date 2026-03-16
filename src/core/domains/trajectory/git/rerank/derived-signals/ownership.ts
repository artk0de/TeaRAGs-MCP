import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { confidenceDampening, fileField, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures author concentration — how much one person dominates the code.
 *
 * Purpose: identify strongly owned code for knowledge transfer or review assignment.
 * Detects: single-owner modules (high score), collaboratively maintained code (low score).
 * Scoring: dominantAuthorPct/100 when available, otherwise 1/authorCount.
 *   Confidence-dampened by commitCount.
 * Used in: ownership preset.
 * Compare: KnowledgeSiloSignal uses discrete contributor count (1→1.0, 2→0.5);
 *   OwnershipSignal uses continuous concentration percentage.
 */
export class OwnershipSignal implements DerivedSignalDescriptor {
  readonly name = "ownership";
  readonly description = "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)";
  readonly sources = ["file.dominantAuthorPct", "file.authors"];
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    let value: number;
    const pct = fileField(rawSignals, "dominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      value = pct / 100;
    } else {
      const authors = fileField(rawSignals, "authors");
      if (Array.isArray(authors) && authors.length > 0) {
        value = authors.length === 1 ? 1 : 1 / authors.length;
      } else {
        return 0;
      }
    }
    const k = ctx?.dampeningThreshold ?? OwnershipSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
