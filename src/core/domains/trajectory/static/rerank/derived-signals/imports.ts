import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

/**
 * Measures the number of import/dependency statements in a chunk.
 *
 * Purpose: proxy for coupling — heavily imported code has more dependents.
 * Detects: hub modules, utility barrels, core abstractions that many files rely on.
 * Scoring: normalized import count. More imports → higher score.
 * Used in: impactAnalysis preset (high imports = high blast radius when changed).
 */
export class ImportsSignal implements DerivedSignalDescriptor {
  readonly name = "imports";
  readonly description = "Normalized import/dependency count";
  readonly sources: string[] = [];
  readonly defaultBound = 20;
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const arr = rawSignals.imports;
    return normalize(Array.isArray(arr) ? arr.length : 0, this.defaultBound);
  }
}
