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

/** Bound on `error.cause` unwrapping; also terminates a cyclic chain. */
const MAX_CAUSE_DEPTH = 5;

/** The error followed by its `cause` chain, outermost first, at most MAX_CAUSE_DEPTH links. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** Deepest-cause-first errno lookup; the outermost error's own code is the last resort. */
function errnoCode(chain: unknown[]): string | undefined {
  for (const link of [...chain.slice(1), ...chain.slice(0, 1)]) {
    const code = (link as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Message of the innermost link that carries one (undici nests the real reason, e.g. "bad port"). */
function innermostMessage(chain: unknown[]): string | undefined {
  for (const link of [...chain].reverse()) {
    const message = (link as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return undefined;
}

/**
 * Errno codes of a connection that never got established: the endpoint is not
 * reachable at all, as opposed to one that answered badly (HTTP 4xx/5xx), was
 * reset mid-request, or was slow on a request it accepted.
 */
const CONNECT_CLASS_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Did the connection itself fail (refused, unreachable, connect timeout)? A request-level abort is not one. */
export function isConnectClassFailure(error: unknown): boolean {
  const code = errnoCode(causeChain(error));
  return code !== undefined && CONNECT_CLASS_CODES.has(code);
}

/** An `AbortSignal.timeout` abort: the request's own deadline ran out. */
export function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export function describeConnectFailure(error: unknown): string {
  const chain = causeChain(error);
  const code = errnoCode(chain);
  if (code !== undefined) {
    const known = KNOWN_CAUSES[code];
    return known ? `${code}: ${known}` : code;
  }
  if (isTimeoutAbort(error)) return "ETIMEDOUT: request timed out";
  return innermostMessage(chain) ?? String(error);
}
