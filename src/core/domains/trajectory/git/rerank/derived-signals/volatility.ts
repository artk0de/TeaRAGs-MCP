import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalizedDamped, chunkNum, confidenceDampening, fileNum } from "./helpers.js";

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
  private static readonly FALLBACK_K = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.churnVolatility"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.churnVolatility"] ?? this.defaultBound;
    const floor = ctx?.confidence?.score?.threshold ?? VolatilitySignal.FALLBACK_K;
    const kf = ctx?.dampeningThreshold ?? floor;
    const kc = ctx?.dampeningThresholdChunk ?? floor;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    const dampFile = confidenceDampening(fileNum(rawSignals, supportName), kf);
    const dampChunk = confidenceDampening(chunkNum(rawSignals, supportName), kc);
    return blendNormalizedDamped(rawSignals, "churnVolatility", fb, cb, ctx?.signalLevel, dampFile, dampChunk);
  }
}
