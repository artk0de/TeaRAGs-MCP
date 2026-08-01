import { normalize } from "../../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

/**
 * Measures interface mass — how many distinct code symbols a file declares.
 *
 * Purpose: rank files by the amount of API surface they carry, which is what
 * makes a god module a god module. Call-graph signals do not substitute: a
 * file with 40 private helpers and fanIn=2 is invisible to the graph.
 * Detects: god modules, god classes (a dominant class holding most of the
 *   file's members — the `godClass` overlay's memberCount decides which).
 * Scoring: `fileSymbolCount` normalized to the adaptive p95 bound.
 * Used in: godModule preset (static and codegraph-enriched variants).
 *
 * The raw value is file-scoped and stamped on every chunk of the file, so
 * this signal is meaningful only under `signalLevel: "file"` presets.
 */
export class SymbolCountSignal implements DerivedSignalDescriptor {
  readonly name = "symbolCount";
  readonly description = "Normalized count of distinct code symbols declared in the file";
  readonly sources = ["fileSymbolCount"];
  readonly defaultBound = 40;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const count = rawSignals.fileSymbolCount;
    // Indices predating the symbol-mass post-pass carry no value at all —
    // contribute nothing rather than poisoning the score with NaN.
    if (typeof count !== "number" || count <= 0) return 0;
    const bound = ctx?.bounds?.["fileSymbolCount"] ?? this.defaultBound;
    return normalize(count, bound);
  }
}
