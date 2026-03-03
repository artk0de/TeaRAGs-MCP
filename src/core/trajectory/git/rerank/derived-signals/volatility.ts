import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

export class VolatilitySignal implements DerivedSignalDescriptor {
  readonly name = "volatility";
  readonly description =
    "Churn volatility: code with erratic commit timing scores higher. L3 blends chunk+file churnVolatility.";
  readonly sources = ["file.churnVolatility", "chunk.churnVolatility"];
  readonly defaultBound = 100;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.churnVolatility"] ?? 100;
    const cb = ctx?.bounds?.["chunk.churnVolatility"] ?? 100;
    let value = blendNormalized(rawSignals, "churnVolatility", fb, cb);
    const k = ctx?.dampeningThreshold ?? VolatilitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
