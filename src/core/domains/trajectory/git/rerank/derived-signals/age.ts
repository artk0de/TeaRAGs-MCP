import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

/**
 * Measures how long ago code was last modified.
 *
 * Purpose: surface legacy/stale code that may need review, update, or deprecation.
 * Detects: unmaintained modules, forgotten utilities, code written for old requirements.
 * Scoring: older code → higher score. Normalized to p95(ageDays) across the result set.
 * Used in: techDebt, securityAudit presets.
 * Inverse: RecencySignal (same raw data, opposite direction).
 */
export class AgeSignal implements DerivedSignalDescriptor {
  readonly name = "age";
  readonly description = "Direct age: older code scores higher. L3 blends chunk+file ageDays.";
  readonly sources = ["file.ageDays", "chunk.ageDays"];
  readonly defaultBound = 365;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.ageDays"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.ageDays"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "ageDays", fb, cb, ctx?.signalLevel);
  }
}
