import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

/**
 * Measures recent commit frequency with exponential time decay.
 *
 * Purpose: detect code that is currently "hot" — receiving a burst of attention right now.
 * Detects: active bug-fixing campaigns, ongoing refactors, features under active development.
 * Scoring: recencyWeightedFreq applies exponential decay so recent commits count more
 *   than old ones. High score = many recent commits in a short window.
 * Compare: DensitySignal treats all months equally; BurstActivitySignal front-loads recent ones.
 *   RecencySignal only checks the last modification date; this considers commit frequency.
 */
export class BurstActivitySignal implements DerivedSignalDescriptor {
  readonly name = "burstActivity";
  readonly description = "Recency-weighted commit frequency. L3 blends chunk+file recencyWeightedFreq.";
  readonly sources = ["file.recencyWeightedFreq", "chunk.recencyWeightedFreq"];
  readonly defaultBound = 10.0;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.recencyWeightedFreq"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.recencyWeightedFreq"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "recencyWeightedFreq", fb, cb, ctx?.signalLevel);
  }
}
