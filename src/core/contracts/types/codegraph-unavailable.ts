/**
 * The codegraph-unavailable error family as domain code sees it (bd
 * tea-rags-mcp-a43tr): the codegraph store cannot be reached from this process
 * right now (daemon stale / skewed / wedged / unreachable, or the DuckDB file
 * will not open). An OPTIONAL codegraph consumer degrades exactly on this family
 * and lets every other failure propagate.
 *
 * The classes live in `adapters/duckdb/errors.ts`; membership is decided here by
 * stable `code`, so a domain consumer needs neither the adapter nor `instanceof`
 * against classes it may not import. A new acquire-failure class belongs in
 * {@link CODEGRAPH_UNAVAILABLE_ERROR_CODES}; `tests/core/adapters/duckdb/
 * errors-codegraph-unavailable-codes.test.ts` fails when the set and the classes
 * disagree.
 */

export const CODEGRAPH_UNAVAILABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "INFRA_CODEGRAPH_DAEMON_STALE_BUILD",
  "INFRA_CODEGRAPH_CLIENT_STALE_BUILD",
  "INFRA_CODEGRAPH_CLIENT_BUILD_TREE_GONE",
  "INFRA_CODEGRAPH_DAEMON_BUILD_SKEW",
  "INFRA_CODEGRAPH_DAEMON_EXIT_TIMEOUT",
  "INFRA_CODEGRAPH_DAEMON_UNREACHABLE",
  "INFRA_CODEGRAPH_DAEMON_UNRESPONSIVE",
  "INFRA_CODEGRAPH_DAEMON_DRAIN_REFUSED",
  "INFRA_CODEGRAPH_DAEMON_BUILD_UNAVAILABLE",
  "INFRA_CODEGRAPH_DB_HELD_BY_FOREIGN_DAEMON",
  "INFRA_DUCKDB_OPEN_FAILED",
]);

/** What a consumer reads off a family member: its code, message and remedy. */
export interface CodegraphUnavailableError extends Error {
  readonly code: string;
  readonly hint: string;
}

export function isCodegraphUnavailableError(err: unknown): err is CodegraphUnavailableError {
  if (!(err instanceof Error)) return false;
  const { code } = err as Error & { code?: unknown };
  return typeof code === "string" && CODEGRAPH_UNAVAILABLE_ERROR_CODES.has(code);
}
