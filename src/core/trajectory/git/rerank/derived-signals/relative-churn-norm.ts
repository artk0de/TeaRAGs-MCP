import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

export class RelativeChurnNormSignal implements DerivedSignalDescriptor {
  readonly name = "relativeChurnNorm";
  readonly description = "Relative churn: total changes relative to file size. L3 blends chunk+file relativeChurn.";
  readonly sources = ["file.relativeChurn"];
  readonly defaultBound = 5.0;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 5.0;
    const effectiveRC = blendSignal(rawSignals, "relativeChurn");
    let value = normalize(effectiveRC, b);
    const k = ctx?.dampeningThreshold ?? RelativeChurnNormSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
