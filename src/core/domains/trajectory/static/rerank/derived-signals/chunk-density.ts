import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

/**
 * Measures code density — characters per line within a method/function.
 *
 * Purpose: surface overly dense code that may be hard to read or maintain.
 * Detects: minified code, one-liner chains, deeply nested expressions,
 *   complex ternary/boolean logic packed into few lines.
 * Scoring: normalized methodDensity (chars/line). Only meaningful for methods
 *   above the size floor (p50 of methodLines). Returns 0 for small snippets
 *   where density is irrelevant.
 * Used in: refactoring preset (dense code = readability improvement candidates).
 */
export class ChunkDensitySignal implements DerivedSignalDescriptor {
  readonly name = "chunkDensity";
  readonly description = "Code density: characters per line (from methodDensity payload field)";
  readonly sources = ["methodDensity", "methodLines"];
  readonly defaultBound = 120;

  /** Absolute minimum method size to consider density meaningful. */
  private readonly sizeFloor = 20;

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0) return 0; // density meaningless without a method/function

    // Adaptive threshold: max(floor, p50(methodLines)) from collection stats
    const p50 = ctx?.collectionStats?.perSignal.get("methodLines")?.percentiles?.[50] ?? 0;
    const sizeThreshold = Math.max(this.sizeFloor, p50);
    if (methodLines < sizeThreshold) return 0; // below-median methods — density irrelevant

    const methodDensity = (rawSignals.methodDensity as number) || 0;
    if (methodDensity <= 0) return 0;
    const bound = ctx?.bounds?.["methodDensity"] ?? this.defaultBound;
    return normalize(methodDensity, bound);
  }
}
