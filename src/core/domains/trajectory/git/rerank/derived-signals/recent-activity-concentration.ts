import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { confidenceDampening, fileField, fileNum } from "./helpers.js";

/**
 * Measures concentration of recent commit activity — how dominated the
 * `git log` window is by a single author.
 *
 * Purpose: identify the right reviewer to CC, the active mentor for
 *   onboarding, the developer currently in flow on a file. Distinct from
 *   OwnershipSignal: that one measures who owns the live lines (state);
 *   this one measures who has been touching the file recently (activity).
 * Detects: feature-in-progress (one author, recent), abandoned ownership
 *   (low concentration despite legacy ownership).
 * Scoring: recentDominantAuthorPct/100 when available, otherwise 1/authors.
 *   Confidence-dampened by commitCount.
 * Used in: codeReview / onboarding presets — places where "who is in this
 *   code right now" matters more than "who owns the lines."
 */
export class RecentActivityConcentrationSignal implements DerivedSignalDescriptor {
  readonly name = "recentActivityConcentration";
  readonly description =
    "Concentration of recent commits in the log window — surfaces the active author, not the long-term owner";
  readonly sources = ["file.recentDominantAuthorPct", "file.recentAuthors"];
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    let value: number;
    const pct = fileField(rawSignals, "recentDominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      value = pct / 100;
    } else {
      const authors = fileField(rawSignals, "recentAuthors");
      if (Array.isArray(authors) && authors.length > 0) {
        value = authors.length === 1 ? 1 : 1 / authors.length;
      } else {
        return 0;
      }
    }
    const k = ctx?.dampeningThreshold ?? RecentActivityConcentrationSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
