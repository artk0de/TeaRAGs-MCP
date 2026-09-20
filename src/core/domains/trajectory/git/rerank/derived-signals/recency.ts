import type { AgeDerivationCapability, DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { AGE_DERIVATION, blendAgeDaysNormalized, nowEpochSeconds } from "../../age-derivation.js";

/**
 * Measures how recently code was modified.
 *
 * Purpose: surface actively developed or recently changed code for review.
 * Detects: fresh changes, in-progress work, recent refactors, new features.
 * Scoring: recently modified → higher score (1 − normalized age).
 * Used in: codeReview, hotspots presets.
 * Inverse: AgeSignal (same raw data, opposite direction).
 * Derivation: computed at query time from `git.{file,chunk}.lastModifiedAt`
 * with `ctx.now` (bd tea-rags-mcp-9ot33) — the stored `ageDays` stamp is not
 * read here and can lag on points that were never re-enriched.
 */
export class RecencySignal implements DerivedSignalDescriptor {
  readonly name = "recency";
  readonly description =
    "Inverse of age: recently modified code scores higher. L3 blends chunk+file age, derived at query time from lastModifiedAt.";
  readonly sources = ["file.lastModifiedAt", "chunk.lastModifiedAt"];
  readonly defaultBound = 365;
  readonly inverted = true as const;
  readonly ageDerivation: AgeDerivationCapability = AGE_DERIVATION;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.lastModifiedAt"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.lastModifiedAt"] ?? this.defaultBound;
    return 1 - blendAgeDaysNormalized(rawSignals, ctx?.now ?? nowEpochSeconds(), fb, cb, ctx?.signalLevel);
  }
}
