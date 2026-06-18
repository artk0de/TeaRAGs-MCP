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
 * Denominator is the chunk's real line span: `methodLines` when present, else
 * `endLine - startLine + 1`. fanOut is a FILE-graph quantity, so the chunk line
 * span is an approximation of file size — acceptable and consistent with the
 * size-moderation intent above. When no size field is present the span
 * degenerates to 1 and the signal reduces to raw fanOut (saturates at the bound).
 *
 * The ratio is normalized against the FIXED `defaultBound` 0.1 ("high coupling
 * per line"). It is intentionally NOT batch-p95-normalized: the adaptive bound
 * collected for the raw `file.fanOut` source is the numerator's distribution,
 * not the ratio's, so feeding it here would mis-scale. (Re-calibrating 0.1
 * against the live p95 of the ratio is a follow-up that needs a fresh index.)
 */
export class FanOutPerLineSignal implements DerivedSignalDescriptor {
  readonly name = "fanOutPerLine";
  readonly description = "Efferent coupling (codegraph.file.fanOut) per line of code";
  readonly sources = ["file.fanOut"];
  readonly defaultBound = 0.1;
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const fanOut = codegraphFileNum(rawSignals, "fanOut");
    if (fanOut <= 0) return 0;
    const ratio = fanOut / lineSpan(rawSignals);
    return normalize(ratio, this.defaultBound);
  }
}

/** Chunk line span: methodLines, else endLine-startLine+1, else 1 (no size info). */
function lineSpan(rawSignals: Record<string, unknown>): number {
  const methodLines = Number(rawSignals.methodLines ?? 0);
  if (methodLines > 0) return methodLines;
  const startLine = Number(rawSignals.startLine ?? 0);
  const endLine = Number(rawSignals.endLine ?? 0);
  if (endLine >= startLine && endLine > 0) return Math.max(endLine - startLine + 1, 1);
  return 1;
}
