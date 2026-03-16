import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

/**
 * Measures how rarely code changes — low churn indicates stable, mature code.
 *
 * Purpose: surface battle-tested code suitable for onboarding, reference, or reuse.
 * Detects: stable APIs, well-established patterns, production-proven modules.
 * Scoring: fewer commits → higher score (1 − normalized commitCount).
 * Used in: onboarding preset.
 * Inverse: ChurnSignal (same raw data, opposite direction).
 */
export class StabilitySignal implements DerivedSignalDescriptor {
  readonly name = "stability";
  readonly description =
    "Inverse of churn: stable code with few commits scores higher. L3 blends chunk+file commitCount.";
  readonly sources = ["file.commitCount", "chunk.commitCount"];
  readonly defaultBound = 50;
  readonly inverted = true as const;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.commitCount"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.commitCount"] ?? this.defaultBound;
    return 1 - blendNormalized(rawSignals, "commitCount", fb, cb, ctx?.signalLevel);
  }
}
