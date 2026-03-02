import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { confidenceDampening, fileNum } from "./helpers.js";

export class VolatilitySignal implements DerivedSignalDescriptor {
  readonly name = "volatility";
  readonly description = "Churn volatility: code with erratic commit timing scores higher (churnVolatility/60)";
  readonly sources = ["file.churnVolatility"];
  readonly defaultBound = 60;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 60;
    let value = normalize(fileNum(rawSignals, "churnVolatility"), b);
    const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
    const k = stats?.percentiles?.[25] ?? VolatilitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
