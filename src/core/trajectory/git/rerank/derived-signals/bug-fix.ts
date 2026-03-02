import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum } from "./helpers.js";

export class BugFixSignal implements DerivedSignalDescriptor {
  readonly name = "bugFix";
  readonly description = "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.";
  readonly sources = ["file.bugFixRate"];
  readonly defaultBound = 100;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 100;
    const effectiveBFR = blendSignal(rawSignals, "bugFixRate");
    let value = normalize(effectiveBFR, b);
    const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
    const k = stats?.percentiles?.[25] ?? BugFixSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
