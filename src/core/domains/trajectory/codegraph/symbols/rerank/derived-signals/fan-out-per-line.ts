import { normalize } from "../../../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { codegraphFileNum } from "./helpers.js";

/**
 * Size-moderated efferent coupling: fanOut per line of code.
 *
 * Sources from the codegraph `codegraph.file.fanOut` raw signal
 * (precise count of files this file imports, populated by the
 * codegraph extractor — TS in Slice 1+2, polyglot in Slice 3+) divided
 * by the static `chunkSize` denominator. Lives in the codegraph
 * trajectory because semantically it IS a fan-graph signal: fanOut
 * is graph-derived; the per-line normalisation is just a scaling
 * trick to follow the class-size meta-study finding (arxiv
 * 2106.04687) that class size moderates fan-out's effect on defects
 * — a 50-fanOut 500-line file is unremarkable (0.1/line), a 50-fanOut
 * 100-line file is structurally fragile (0.5/line).
 *
 * The earlier (rejected) version sourced from the static `imports[]`
 * payload field directly. `imports[]` IS the underlying data — but
 * routing through `codegraph.file.fanOut` keeps the fan-graph signal
 * graph the single source of truth: when D1's universal-coverage
 * reverse-pass lands, non-TS files will get fanOut populated from
 * imports[] inside the codegraph layer, and this derived signal
 * automatically inherits universal coverage without touching its
 * source key.
 *
 * See `.claude/rules/imports-field-semantics.md` — `imports[]` payload
 * is a visual mask only; signals route through codegraph.file.fanOut.
 *
 * Default bound 0.1 is a typical reference for "high coupling per line".
 * Collection-stats p95 overrides via `bounds["chunk.fanOutPerLine"]`.
 */
export class FanOutPerLineSignal implements DerivedSignalDescriptor {
  readonly name = "fanOutPerLine";
  readonly description = "Efferent coupling (codegraph.file.fanOut) per line of code";
  readonly sources = ["file.fanOut"];
  readonly defaultBound = 0.1;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fanOut = codegraphFileNum(rawSignals, "fanOut");
    const size = Number(rawSignals.chunkSize ?? 1);
    const ratio = fanOut / Math.max(size, 1);
    const bound = ctx?.bounds?.["chunk.fanOutPerLine"] ?? this.defaultBound;
    return normalize(ratio, bound);
  }
}
