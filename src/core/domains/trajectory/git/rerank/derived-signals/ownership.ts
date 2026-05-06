import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { confidenceDampening, fileField, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures live-line author concentration — how much one person owns the
 * code as it currently stands in HEAD (computed from `git blame HEAD`).
 *
 * Purpose: identify true ownership for knowledge transfer, style matching,
 *   and silo-risk assessment. Decoupled from the `git log` window — a file
 *   written long ago by Alice with a recent fix-commit by Bob still scores
 *   as Alice-owned by line share.
 * Detects: single-owner modules (high score), distributed live ownership
 *   (low score).
 * Scoring: lineDominantAuthorPct/100 when available, otherwise 1/lineAuthors.
 *   Confidence-dampened by commitCount.
 * Used in: ownership preset (and any custom rerank that weights `ownership`).
 * Compare: KnowledgeSiloSignal uses discrete contributor count
 *   (1→1.0, 2→0.5); RecentActivityConcentrationSignal uses commit-based
 *   concentration over the log window.
 */
export class OwnershipSignal implements DerivedSignalDescriptor {
  readonly name = "ownership";
  readonly description =
    "Live-line author concentration: single-owner code by blame share scores higher (lineDominantAuthorPct or 1/lineAuthors)";
  readonly sources = ["file.lineDominantAuthorPct", "file.lineAuthors"];
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    let value: number;
    const pct = fileField(rawSignals, "lineDominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      value = pct / 100;
    } else {
      const authors = fileField(rawSignals, "lineAuthors");
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
