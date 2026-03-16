import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures commit frequency normalized by time — commits per month.
 *
 * Purpose: distinguish sustained activity from one-time bursts.
 * Detects: persistently problematic areas (high density = constant fixes),
 *   vs one-off large changes (high churn but low density).
 * Scoring: more commits/month → higher score. Confidence-dampened by commitCount.
 * Compare: ChurnSignal measures absolute count; DensitySignal normalizes by age.
 *   BurstActivitySignal weights recent commits exponentially; this treats all months equally.
 */
export class DensitySignal implements DerivedSignalDescriptor {
  readonly name = "density";
  readonly description = "Change density: commits per month. L3 blends chunk+file changeDensity.";
  readonly sources = ["file.changeDensity", "chunk.changeDensity"];
  readonly defaultBound = 20;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.changeDensity"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.changeDensity"] ?? this.defaultBound;
    let value = blendNormalized(rawSignals, "changeDensity", fb, cb, ctx?.signalLevel);
    const k = ctx?.dampeningThreshold ?? DensitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
