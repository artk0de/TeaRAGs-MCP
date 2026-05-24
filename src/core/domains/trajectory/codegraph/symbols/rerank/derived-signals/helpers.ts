/**
 * Codegraph-specific payload accessors for derived signals.
 *
 * EnrichmentApplier writes codegraph signals with key `codegraph.symbols.file`
 * / `codegraph.symbols.chunk`. Qdrant interprets dotted keys as a path, so the
 * real on-disk shape is:
 *   { codegraph: { symbols: { file: { "codegraph.file.fanIn": N, ... } } } }
 * The inner keys keep their literal dotted form. These accessors read the
 * nested form first and fall back to flat (`raw["codegraph.file.X"]` at the
 * root) so unit tests can feed flat objects without restructuring.
 *
 * Mirrors the git helpers at
 * `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`.
 */

interface SymbolsScope {
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

interface CodegraphLike {
  symbols?: SymbolsScope;
  [key: string]: unknown;
}

function getSymbols(payload: Record<string, unknown>): SymbolsScope | undefined {
  const cg = payload.codegraph;
  if (!cg || typeof cg !== "object") return undefined;
  const { symbols } = cg as CodegraphLike;
  if (symbols && typeof symbols === "object") return symbols;
  return undefined;
}

function readNested(scope: Record<string, unknown> | undefined, key: string): unknown {
  if (!scope) return undefined;
  if (key in scope) return scope[key];
  return undefined;
}

/** Read a numeric `codegraph.file.<suffix>` value from nested or flat payload. */
export function codegraphFileNum(payload: Record<string, unknown>, suffix: string): number {
  const key = `codegraph.file.${suffix}`;
  const nested = readNested(getSymbols(payload)?.file, key);
  const raw = nested !== undefined ? nested : payload[key];
  const n = Number(raw ?? 0);
  return Number.isNaN(n) ? 0 : n;
}

/** Read a boolean `codegraph.file.<suffix>` value from nested or flat payload. */
export function codegraphFileBool(payload: Record<string, unknown>, suffix: string): boolean {
  const key = `codegraph.file.${suffix}`;
  const nested = readNested(getSymbols(payload)?.file, key);
  return (nested !== undefined ? nested : payload[key]) === true;
}

/** Read a numeric `codegraph.chunk.<suffix>` value from nested or flat payload. */
export function codegraphChunkNum(payload: Record<string, unknown>, suffix: string): number {
  const key = `codegraph.chunk.${suffix}`;
  const nested = readNested(getSymbols(payload)?.chunk, key);
  const raw = nested !== undefined ? nested : payload[key];
  const n = Number(raw ?? 0);
  return Number.isNaN(n) ? 0 : n;
}
