import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { fileNum } from "./helpers.js";

export class VolatilitySignal implements DerivedSignalDescriptor {
  readonly name = "volatility";
  readonly description = "Churn volatility: code with erratic commit timing scores higher (churnVolatility/60)";
  readonly sources = ["churnVolatility"];
  readonly defaultBound = 60;
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 60;
    return normalize(fileNum(rawSignals, "churnVolatility"), b);
  }
}
