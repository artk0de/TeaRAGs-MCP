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

/** Read a numeric `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileNum(
  payload: Record<string, unknown>,
  suffix: string,
): number {
  const n = Number(
    resolvePayloadValue(payload, `codegraph.file.${suffix}`) ?? 0,
  );
  return Number.isNaN(n) ? 0 : n;
}

/** Read a boolean `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileBool(
  payload: Record<string, unknown>,
  suffix: string,
): boolean {
  return resolvePayloadValue(payload, `codegraph.file.${suffix}`) === true;
}

/** Read a numeric `codegraph.chunk.<suffix>` value via the canonical resolver. */
export function codegraphChunkNum(
  payload: Record<string, unknown>,
  suffix: string,
): number {
  const n = Number(
    resolvePayloadValue(payload, `codegraph.chunk.${suffix}`) ?? 0,
  );
  return Number.isNaN(n) ? 0 : n;
}
