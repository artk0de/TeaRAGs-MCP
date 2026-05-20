import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

/**
 * Size-moderated efferent coupling: imports per line of code.
 *
 * The naïve `imports` derived signal correlates with file size — large
 * files import more, but that's not the same as being "tightly coupled".
 * Per the class-size meta-study (arxiv 2106.04687), class size moderates
 * fan-out's effect on defects: a 50-import 500-line file is unremarkable
 * (0.1/line), while a 50-import 100-line file is structurally fragile
 * (0.5/line).
 *
 * Computed at rerank time as `imports.length / max(chunkSize, 1)` from
 * existing static payload (no new raw signal needed). Bounded by
 * `defaultBound = 0.1` — typical reference value for a "high
 * coupling-per-line" file. Collection-stats p95 can override via
 * `bounds["chunk.fanOutPerLine"]`.
 *
 * Used by composite presets (onboarding, stable, entryPoint, etc.) as
 * the size-normalized counterpart to `imports` / `fanOut`.
 */
export class FanOutPerLineSignal implements DerivedSignalDescriptor {
  readonly name = "fanOutPerLine";
  readonly description = "Imports per line of code (size-moderated efferent coupling)";
  readonly sources: string[] = [];
  readonly defaultBound = 0.1;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const arr = rawSignals.imports;
    const importCount = Array.isArray(arr) ? arr.length : 0;
    const size = Number(rawSignals.chunkSize ?? 1);
    const ratio = importCount / Math.max(size, 1);
    const bound = ctx?.bounds?.["chunk.fanOutPerLine"] ?? this.defaultBound;
    return normalize(ratio, bound);
  }
}
