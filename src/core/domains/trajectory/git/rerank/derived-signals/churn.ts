import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

/**
 * Measures absolute commit frequency — how many times code was changed.
 *
 * Purpose: identify heavily modified areas that attract repeated attention.
 * Detects: hotspots, code under active development, areas with frequent fixes.
 * Scoring: more commits → higher score. Normalized to p95(commitCount).
 * Blending: L3 alpha-blend of chunk + file commitCount.
 * Used in: hotspots, refactoring presets.
 * Inverse: StabilitySignal (same raw data, opposite direction).
 * Compare: RelativeChurnNormSignal normalizes by file size; this is absolute.
 */
export class ChurnSignal implements DerivedSignalDescriptor {
  readonly name = "churn";
  readonly description =
    "Direct commit count: frequently changed code scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["file.commitCount", "chunk.commitCount"];
  readonly defaultBound = 50;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.commitCount"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "commitCount", fb, cb, ctx?.signalLevel);
  }
}
