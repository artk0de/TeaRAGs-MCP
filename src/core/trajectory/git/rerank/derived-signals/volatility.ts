import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

export class VolatilitySignal implements DerivedSignalDescriptor {
  readonly name = "volatility";
  readonly description =
    "Churn volatility: code with erratic commit timing scores higher. L3 blends chunk+file churnVolatility.";
  readonly sources = ["file.churnVolatility", "chunk.churnVolatility"];
  readonly defaultBound = 100;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 100;
    let value = normalize(blendSignal(rawSignals, "churnVolatility"), b);
    const k = ctx?.dampeningThreshold ?? VolatilitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
