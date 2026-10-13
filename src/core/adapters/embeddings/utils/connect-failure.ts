/**
 * Operator-facing cause of a failed connection to an embedding endpoint.
 *
 * Node's `fetch` wraps the socket error: the errno lives on `error.cause.code`,
 * and an `AbortSignal.timeout` abort arrives as a `TimeoutError`. The raw
 * message ("fetch failed") names nothing, so status output would read as a bare
 * "unavailable" (bd tea-rags-mcp-fembu).
 */

const KNOWN_CAUSES: Readonly<Record<string, string>> = {
  EHOSTUNREACH: "host unreachable (on macOS a background process may lack Local Network permission)",
  ENETUNREACH: "network unreachable (on macOS a background process may lack Local Network permission)",
  ECONNREFUSED: "connection refused - nothing listening on that port",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  ENOTFOUND: "host name does not resolve",
};

function errnoCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function describeConnectFailure(error: unknown): string {
  const code = errnoCode(error);
  if (code !== undefined) {
    const known = KNOWN_CAUSES[code];
    return known ? `${code}: ${known}` : code;
  }
  if (error instanceof Error && error.name === "TimeoutError") return "ETIMEDOUT: request timed out";
  return error instanceof Error ? error.message : String(error);
}
