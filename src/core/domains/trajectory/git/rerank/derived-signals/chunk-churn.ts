import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

/**
 * Chunk-only commit count, weighted by alpha confidence.
 *
 * Purpose: isolate chunk-level churn without file-level fallback blending.
 * Detects: specific functions/methods that are modified disproportionately often,
 *   even when the overall file churn is low.
 * Scoring: normalize(chunk.commitCount) × alpha. Returns 0 when chunk data is absent
 *   or unreliable (low alpha).
 * Compare: ChurnSignal blends file+chunk via L3; this exposes chunk-only activity.
 *   Useful for chunk-level analytics where file averaging would hide hotspots.
 */
export class ChunkChurnSignal implements DerivedSignalDescriptor {
  readonly name = "chunkChurn";
  readonly description = "Chunk-level commit count, dampened by alpha (coverage confidence).";
  readonly sources = ["chunk.commitCount", "file.commitCount"];
  readonly defaultBound = 30;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    const chunkCC = chunkNum(rawSignals, "commitCount");
    const alpha = payloadAlpha(rawSignals, ctx?.signalLevel);
    return normalize(chunkCC, b) * alpha;
  }
}
