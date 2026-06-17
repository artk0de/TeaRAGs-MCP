import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalizedDamped, chunkNum, confidenceDampening, fileNum } from "./helpers.js";

/**
 * Churn relative to file size — lines changed divided by total LOC.
 *
 * Purpose: normalize churn by code volume so small hot files rank above large stable ones.
 * Detects: disproportionately modified code — a 50-line file with 20 commits is more
 *   suspicious than a 5000-line file with 20 commits.
 * Scoring: normalized relativeChurn, confidence-dampened by commitCount.
 *   L3 blends chunk+file relativeChurn.
 * Compare: ChurnSignal is absolute count; this accounts for file size.
 *   ChunkRelativeChurnSignal measures chunk's share of file churn (ratio within file).
 */
export class RelativeChurnNormSignal implements DerivedSignalDescriptor {
  readonly name = "relativeChurnNorm";
  readonly description = "Relative churn: total changes relative to file size. L3 blends chunk+file relativeChurn.";
  readonly sources = ["file.relativeChurn", "chunk.relativeChurn"];
  readonly defaultBound = 5.0;
  private static readonly FALLBACK_K = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.relativeChurn"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.relativeChurn"] ?? this.defaultBound;
    const floor = ctx?.confidence?.score?.threshold ?? RelativeChurnNormSignal.FALLBACK_K;
    const kf = ctx?.dampeningThreshold ?? floor;
    const kc = ctx?.dampeningThresholdChunk ?? floor;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    const dampFile = confidenceDampening(fileNum(rawSignals, supportName), kf);
    const dampChunk = confidenceDampening(chunkNum(rawSignals, supportName), kc);
    return blendNormalizedDamped(rawSignals, "relativeChurn", fb, cb, ctx?.signalLevel, dampFile, dampChunk);
  }
}
