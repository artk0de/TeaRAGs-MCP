import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum } from "./helpers.js";

export class DensitySignal implements DerivedSignalDescriptor {
  readonly name = "density";
  readonly description = "Change density: commits per month. L3 blends chunk+file changeDensity.";
  readonly sources = ["changeDensity"];
  readonly defaultBound = 20;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 20;
    const effectiveDensity = blendSignal(rawSignals, "changeDensity");
    let value = normalize(effectiveDensity, b);
    const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
    const k = stats?.p25 ?? DensitySignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
