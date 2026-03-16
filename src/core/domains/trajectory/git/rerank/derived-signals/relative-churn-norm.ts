import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

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
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.relativeChurn"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.relativeChurn"] ?? this.defaultBound;
    let value = blendNormalized(rawSignals, "relativeChurn", fb, cb, ctx?.signalLevel);
    const k = ctx?.dampeningThreshold ?? RelativeChurnNormSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
