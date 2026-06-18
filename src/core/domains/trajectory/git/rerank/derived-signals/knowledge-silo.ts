import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blend, chunkField, confidenceDampening, fileNum, payloadAlpha } from "./helpers.js";

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
    // Scope-aware: siloScore each scope's contributor count, dampen by that
    // scope's own support, then blend with the same alpha (per-scope confidence,
    // not the file scope applied to the whole blend). siloScore is piecewise
    // linear, so within a knot segment this matches siloScore-of-the-blend.
    const floor = ctx?.confidence?.score?.threshold ?? KnowledgeSiloSignal.FALLBACK_K;
    const kf = ctx?.dampeningThreshold ?? floor;
    const kc = ctx?.dampeningThresholdChunk ?? floor;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    const dampFile = confidenceDampening(fileNum(rawSignals, supportName), kf);
    const fileCount = fileNum(rawSignals, "blameContributorCount");
    const sf = siloScore(fileCount) * dampFile;
    const alpha = payloadAlpha(rawSignals, ctx?.signalLevel);
    if (alpha === 0) return sf;
    const dampChunk = confidenceDampening(chunkField(rawSignals, supportName) ?? 0, kc);
    const chunkCount = chunkField(rawSignals, "blameContributorCount") ?? fileCount;
    const sc = siloScore(chunkCount) * dampChunk;
    return blend(sc, sf, alpha);
  }
}
