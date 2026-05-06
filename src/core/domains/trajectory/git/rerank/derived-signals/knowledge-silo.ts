import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures bus factor risk — code with only one or two distinct authors of
 * the live lines (computed from `git blame HEAD`).
 *
 * Purpose: surface knowledge silos where a single contributor departure
 *   would leave the team without the expertise embedded in current code.
 * Detects: single-author modules (1 live-line contributor), pair-only code
 *   (2), undocumented tribal knowledge.
 * Scoring: 1 contributor → 1.0, 2 contributors → 0.5, 3+ → 0.0.
 *   Confidence-dampened by commitCount (low-commit files may simply be new).
 *   L3 alpha-blends file and chunk lineContributorCount.
 * Compare: OwnershipSignal measures continuous concentration percentage
 *   (lineDominantAuthorPct); KnowledgeSiloSignal measures absolute count.
 */
export class KnowledgeSiloSignal implements DerivedSignalDescriptor {
  readonly name = "knowledgeSilo";
  readonly description =
    "Knowledge silo risk by live-line contributors: 1=1.0, 2=0.5, 3+=0. L3 blends file+chunk lineContributorCount.";
  readonly sources = ["file.lineContributorCount", "chunk.lineContributorCount"];
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const effectiveCount = blendSignal(rawSignals, "lineContributorCount", ctx?.signalLevel);
    let value: number;
    if (effectiveCount <= 0) return 0;
    if (effectiveCount === 1) value = 1.0;
    else if (effectiveCount === 2) value = 0.5;
    else return 0;
    const k = ctx?.dampeningThreshold ?? KnowledgeSiloSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
