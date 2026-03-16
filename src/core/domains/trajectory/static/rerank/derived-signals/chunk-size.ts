import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

/**
 * Measures the size of a code chunk in lines.
 *
 * Purpose: boost or penalize results by code volume.
 * Detects: large methods/classes (refactoring candidates when weighted positively),
 *   or small focused functions (when weighted negatively / used inversely).
 * Scoring: normalized methodLines to p95 bound. Larger chunks → higher score.
 * Used in: refactoring preset (large chunks = split candidates).
 */
export class ChunkSizeSignal implements DerivedSignalDescriptor {
  readonly name = "chunkSize";
  readonly description = "Normalized method/block size in lines (from methodLines payload field)";
  readonly sources = ["methodLines"];
  readonly defaultBound = 500;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0) return 0;
    const bound = ctx?.bounds?.["methodLines"] ?? this.defaultBound;
    return normalize(methodLines, bound);
  }
}
