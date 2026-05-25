/**
 * Codegraph-specific payload accessors for derived signals.
 *
 * EnrichmentApplier writes codegraph signals with key `codegraph.symbols.file`
 * / `codegraph.symbols.chunk`. Qdrant interprets dotted keys as a path, and
 * buildFileSignals/buildChunkSignals write BARE inner keys (tea-rags-mcp-k6xu),
 * so the real on-disk shape is:
 *   { codegraph: { symbols: { file: { fanIn: N, ... } } } }
 * mirroring git's `payload.git.file.commitCount` shape. These accessors read
 * the bare nested form first and fall back to the flat dotted form
 * (`raw["codegraph.file.X"]` at the root) so unit tests can feed flat objects
 * without restructuring.
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
  // Bare nested key first (production write path), then flat dotted fallback.
  const nested = readNested(getSymbols(payload)?.file, suffix);
  const raw = nested !== undefined ? nested : payload[`codegraph.file.${suffix}`];
  const n = Number(raw ?? 0);
  return Number.isNaN(n) ? 0 : n;
}

/** Read a boolean `codegraph.file.<suffix>` value from nested or flat payload. */
export function codegraphFileBool(payload: Record<string, unknown>, suffix: string): boolean {
  const nested = readNested(getSymbols(payload)?.file, suffix);
  return (nested !== undefined ? nested : payload[`codegraph.file.${suffix}`]) === true;
}

/** Read a numeric `codegraph.chunk.<suffix>` value from nested or flat payload. */
export function codegraphChunkNum(payload: Record<string, unknown>, suffix: string): number {
  const nested = readNested(getSymbols(payload)?.chunk, suffix);
  const raw = nested !== undefined ? nested : payload[`codegraph.chunk.${suffix}`];
  const n = Number(raw ?? 0);
  return Number.isNaN(n) ? 0 : n;
}
