import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { hasChunkData, payloadAlpha } from "./helpers.js";

/**
 * Data quality correction for "block" chunks (catch-all code outside functions/classes).
 *
 * Purpose: penalize block chunks that lack reliable chunk-level git data.
 * Detects: low-confidence results where git signals are inherited from the file level
 *   rather than computed for the specific code range.
 * Scoring: 1.0 = full penalty (no chunk data), 0.0 = no penalty (reliable chunk data).
 *   Non-block chunks always get 0 penalty. Applied as an inverted weight (subtracted).
 * Used in: any preset — ensures block chunks don't rank artificially high from
 *   borrowed file-level signals.
 */
export class BlockPenaltySignal implements DerivedSignalDescriptor {
  readonly name = "blockPenalty";
  readonly description =
    "Data quality discount for block chunks: 1.0 if block without chunk data (alpha=0), 0 otherwise";
  readonly sources = ["chunk.commitCount", "file.commitCount"];
  readonly inverted = true as const;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const { chunkType } = rawSignals;
    if (chunkType !== "block") return 0;
    // If chunk-level git data exists, compute alpha to determine penalty
    if (hasChunkData(rawSignals)) {
      const alpha = payloadAlpha(rawSignals, ctx?.signalLevel);
      return 1.0 - alpha;
    }
    // No chunk data at all — full penalty
    return 1.0;
  }
}
