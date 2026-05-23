import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

/**
 * @deprecated Legacy — predates the codegraph fan-graph signal layer.
 *
 * Reads `imports.length` directly from static payload, which is the
 * underlying raw value behind `codegraph.file.fanOut`. Per the
 * `imports-field-semantics.md` rule, statistical and derived signals
 * MUST source efferent coupling from `codegraph.file.fanOut` (or
 * `codegraph.chunk.fanOut`) rather than `imports[]` — the codegraph
 * layer is the single source of truth and will gain universal
 * coverage via the Slice 2 D1 reverse-pass.
 *
 * Description here is also semantically wrong by modern naming —
 * "heavily imported code has more dependents" describes fanIn, but the
 * field measures fanOut. Kept around only for back-compat with
 * existing presets that still reference the `imports` weight key.
 * Removal is a `feat(presets)!` breaking change pending preset
 * migration to `fanOut` / `fanOutPerLine`.
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
