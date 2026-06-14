import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum } from "./helpers.js";

/**
 * Piecewise-linear silo score over a (possibly fractional) contributor count:
 * 1 → 1.0, 2 → 0.5, 3+ → 0, linear between the knots. Continuous because the
 * input is an alpha-blend of file and chunk counts; a discrete `=== 1`/`=== 2`
 * map silently zeroed every mixed (non-integer) blend — exactly the file/chunk
 * divergence L3 blending exists to express. Rounding is rejected: it
 * reintroduces a cliff at x.5 and discards the blend information.
 */
function siloScore(n: number): number {
  if (n <= 0) return 0;
  if (n <= 1) return 1.0;
  if (n <= 2) return 1.0 - 0.5 * (n - 1); // 1..2 → 1.0..0.5
  if (n <= 3) return 0.5 - 0.5 * (n - 2); // 2..3 → 0.5..0
  return 0;
}

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
 *   L3 alpha-blends file and chunk blameContributorCount.
 * Compare: OwnershipSignal measures continuous concentration percentage
 *   (blameDominantAuthorPct); KnowledgeSiloSignal measures absolute count.
 */
export class KnowledgeSiloSignal implements DerivedSignalDescriptor {
  readonly name = "knowledgeSilo";
  readonly description =
    "Knowledge silo risk by live-line contributors: 1=1.0, 2=0.5, 3+=0. L3 blends file+chunk blameContributorCount.";
  readonly sources = ["file.blameContributorCount", "chunk.blameContributorCount"];
  private static readonly FALLBACK_K = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const effectiveCount = blendSignal(rawSignals, "blameContributorCount", ctx?.signalLevel);
    const value = siloScore(effectiveCount);
    if (value === 0) return 0;
    const k = ctx?.dampeningThreshold ?? ctx?.confidence?.score?.threshold ?? KnowledgeSiloSignal.FALLBACK_K;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    return value * confidenceDampening(fileNum(rawSignals, supportName), k);
  }
}
