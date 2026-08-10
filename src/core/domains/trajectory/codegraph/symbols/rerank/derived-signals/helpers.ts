/**
 * Codegraph-specific payload accessors for derived signals.
 *
 * All payload addressing routes through the canonical resolvePayloadValue
 * (contracts/signal-utils.ts) — the single source of truth for payload
 * shapes (flat dotted key, codegraph nested-symbols
 * `codegraph.symbols.{file|chunk}.X`, plain nested traversal). These wrappers
 * add only suffix prefixing and num/bool coercion.
 *
 * Mirrors the git helpers at
 * `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`.
 */

import { resolvePayloadValue } from "../../../../../../contracts/signal-utils.js";
import type { SignalLevel } from "../../../../../../contracts/types/reranker.js";

/** Read a numeric `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileNum(payload: Record<string, unknown>, suffix: string): number {
  const n = Number(resolvePayloadValue(payload, `codegraph.file.${suffix}`) ?? 0);
  return Number.isNaN(n) ? 0 : n;
}

/** Read a boolean `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileBool(payload: Record<string, unknown>, suffix: string): boolean {
  return resolvePayloadValue(payload, `codegraph.file.${suffix}`) === true;
}

/**
 * Read a numeric `codegraph.chunk.<suffix>` value via the canonical resolver,
 * scoped OUT at file level.
 *
 * There is no file-scope counterpart to these numbers — the file-level codegraph
 * signals are fanIn / fanOut / instability / connectionCount / transitiveImpact.
 * A file-aggregated result still carries a `codegraph.chunk.*` block, but it is
 * the block of that file's REPRESENTATIVE chunk, so reading it at file level
 * hands one arbitrary method's centrality to the whole file. That is worse than
 * a zero: it scores on noise, and `buildOverlay` drops the chunk mask at file
 * level (`skipChunk`), so the number never appears in the overlay that would
 * have exposed it.
 *
 * Returning 0 mirrors what git's chunk-primary signals already do through
 * `payloadAlpha(payload, signalLevel)` — see the `chunkChurn dropped` comments
 * on the `ownership` and `securityAudit` presets. A file-level preset that
 * weights one of these now carries a visible dead weight instead of a silent
 * wrong one, which is the failure mode you can actually notice.
 */
export function codegraphChunkNum(payload: Record<string, unknown>, suffix: string, signalLevel?: SignalLevel): number {
  if (signalLevel === "file") return 0;
  const n = Number(resolvePayloadValue(payload, `codegraph.chunk.${suffix}`) ?? 0);
  return Number.isNaN(n) ? 0 : n;
}
