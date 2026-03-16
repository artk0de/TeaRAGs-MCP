import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures irregularity of commit timing — erratic vs steady change patterns.
 *
 * Purpose: distinguish panic-driven changes (spikes after incidents) from steady evolution.
 * Detects: code that gets bursts of emergency fixes followed by long quiet periods,
 *   suggesting fragile logic or unclear ownership.
 * Scoring: higher churnVolatility (std dev of commit intervals) → higher score.
 *   Confidence-dampened by commitCount (need enough data points for meaningful std dev).
 * Compare: DensitySignal measures average rate; VolatilitySignal measures variance.
 *   BurstActivitySignal weights recent commits; VolatilitySignal considers full history.
 */
export class VolatilitySignal implements DerivedSignalDescriptor {
  readonly name = "volatility";
  readonly description =
    "Churn volatility: code with erratic commit timing scores higher. L3 blends chunk+file churnVolatility.";
  readonly sources = ["file.churnVolatility", "chunk.churnVolatility"];
  readonly defaultBound = 100;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.churnVolatility"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.churnVolatility"] ?? this.defaultBound;
    let value = blendNormalized(rawSignals, "churnVolatility", fb, cb, ctx?.signalLevel);
    const k = ctx?.dampeningThreshold ?? VolatilitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
