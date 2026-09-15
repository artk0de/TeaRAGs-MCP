/**
 * DuckDB adapter errors. Lives at the adapter layer per
 * `.claude/rules/domain-boundaries.md` — adapter wraps external driver
 * failures into typed `InfraError` subclasses; consumers (bootstrap
 * pool, codegraph trajectory) catch / re-throw without leaking raw
 * driver messages.
 */

import { InfraError } from "../errors.js";

/**
 * DuckDB file open / initialisation failed — usually a concurrent
 * tea-rags process holding the file lock (DuckDB is single-writer per
 * file), but also surfaces I/O errors (permission denied, missing
 * directory, corrupted file). The pool catches this to degrade
 * gracefully: the offending collection runs without codegraph until
 * the lock is released or the file is repaired.
 */
export class DuckDbOpenFailedError extends InfraError {
  constructor(dbPath: string, cause?: Error) {
    super({
      code: "INFRA_DUCKDB_OPEN_FAILED",
      message: `Failed to open DuckDB at ${dbPath}`,
      hint:
        "DuckDB is single-writer per file. Another tea-rags MCP process likely holds the lock — " +
        "stop the duplicate server or wait for it to idle out, then retry. Codegraph for this " +
        "collection is disabled in this process until the lock is released.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The codegraph store refused to CREATE `<base>.duckdb` because
 * `<base>_v<N>.duckdb` generations already sit beside it (bd tea-rags-mcp-39xca.1).
 *
 * That shape is a shadow database: the file an alias-addressed write opens when
 * it should have opened the versioned physical collection — the 6goqa, snbzk
 * and xjkvw class, where writes landed in a file no reader opens and recall
 * degraded with no error. The brand on `PhysicalCollectionName` keeps an alias
 * away from the pool at compile time; this is the runtime backstop for the one
 * place that could still create the wrong file. A caller bug, not an outage —
 * hence 500, and deliberately outside `CodegraphUnavailableError`, so no
 * optional consumer degrades on it quietly.
 */
export class CodegraphShadowDatabaseRefusedError extends InfraError {
  constructor(shadow: { collectionName: string; dbPath: string; generations: readonly string[] }, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_SHADOW_DATABASE_REFUSED",
      message:
        `Refused to create codegraph database ${shadow.dbPath}: "${shadow.collectionName}" already has ` +
        `versioned generations (${shadow.generations.join(", ")}), so it names an alias base, not a physical collection`,
      hint:
        "The codegraph is keyed by the PHYSICAL versioned collection. Resolve the name with " +
        "resolvePhysicalCollection before acquiring the pool — an alias here writes a shadow database " +
        "no reader ever opens. Nothing was created.",
      httpStatus: 500,
      cause,
    });
  }
}

/**
 * The codegraph daemon still presents a DIFFERENT build fingerprint after every
 * bounded drain-restart attempt (bd tea-rags-mcp-ji56r, bound widened by
 * tea-rags-mcp-ryoqn).
 *
 * The two ways to get here need opposite responses, and the fingerprints seen
 * AFTER each restart tell them apart. A different build each time means other
 * live sessions keep winning the cross-process spawn lock and cold-spawning
 * from their own trees — transient, worth retrying. The same build every time
 * means nobody is racing us: our own respawn hook keeps launching one stale
 * binary, which retrying will never fix.
 */
export class CodegraphDaemonStaleBuildError extends InfraError {
  constructor(
    socketPath: string,
    clientFingerprint: string,
    daemonFingerprint: string,
    /** Fingerprint observed after each restart attempt, in order. */
    observedDaemonFingerprints: readonly string[],
    cause?: Error,
  ) {
    const attempts = observedDaemonFingerprints.length;
    const distinct = [...new Set(observedDaemonFingerprints)];
    super({
      code: "INFRA_CODEGRAPH_DAEMON_STALE_BUILD",
      // The remedy rides the message itself (bd tea-rags-mcp-a43tr): consumers
      // that degrade on this error (find_symbol's optional codegraph hop) quote
      // the message, and the common cause is THIS server process holding the old
      // build while the respawn hook launches the rebuilt daemon — no restart
      // attempt can converge on that; only restarting the MCP server does.
      message:
        `Codegraph daemon at ${socketPath} still runs a different build after ` +
        `${attempts} restart attempt${attempts === 1 ? "" : "s"} ` +
        `(daemon=${daemonFingerprint}, client=${clientFingerprint}) — restart the tea-rags MCP server ` +
        "(e.g. `/mcp reconnect`) so it and the daemon load one build",
      hint:
        distinct.length > 1
          ? "A parallel tea-rags session kept cold-spawning the daemon from another build — a " +
            `different one answered after each restart (${distinct.join(", ")}), which is the ` +
            "signature of a transient multi-process race, not a wedged daemon. Retry once the " +
            "other session finishes, or re-run `npm run build && npm link` so every session " +
            "shares one build, then restart the MCP server (`/mcp reconnect`)."
          : `The same build came back after every restart (${distinct.join(", ")}), so no other ` +
            "session is racing us. Either this MCP server process predates the last build — the " +
            "respawn hook launches the rebuilt daemon while this process keeps the old fingerprint, " +
            "so retrying can never converge: restart the MCP server (`/mcp reconnect`) — or the " +
            "respawn hook launches a stale binary (a `build/` that was never rebuilt, or an " +
            "`npm link` pointing at another checkout): re-run `npm run build && npm link` in the " +
            "checkout you intend to use, then reconnect.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The codegraph daemon cannot serve an op this client may need, and nothing
 * here can replace it (bd tea-rags-mcp-39xca.4).
 *
 * Thrown in two places. At connect, by a pool WITHOUT a respawn hook (worker
 * threads rebuild their pool from serializable config and cannot cold-spawn a
 * daemon): it used to proceed against a daemon from another build, and every
 * op that daemon lacked came back as an empty answer — wrong data, not a
 * failure (the weno4 hydration no-op). The main-thread pool wires the hook and
 * replaces such a daemon instead. At call time, by the client, for an op
 * outside `LEGACY_TOLERATED_OPS` that the daemon still answers as unknown.
 *
 * `missingOps` is empty when the daemon predates capability advertisement and
 * reports a different build: there is nothing to name, and no evidence it is
 * safe to proceed.
 */
export class CodegraphDaemonBuildSkewError extends InfraError {
  readonly missingOps: readonly string[];

  constructor(
    skew: {
      socketPath: string;
      missingOps: readonly string[];
      clientFingerprint?: string;
      daemonFingerprint?: string;
    },
    cause?: Error,
  ) {
    const builds =
      skew.daemonFingerprint === undefined && skew.clientFingerprint === undefined
        ? ""
        : ` (daemon=${skew.daemonFingerprint ?? "unknown"}, client=${skew.clientFingerprint ?? "unknown"})`;
    super({
      code: "INFRA_CODEGRAPH_DAEMON_BUILD_SKEW",
      message:
        skew.missingOps.length > 0
          ? `Codegraph daemon at ${skew.socketPath} runs an older build without ` +
            `op${skew.missingOps.length === 1 ? "" : "s"} ${skew.missingOps.join(", ")}${builds}`
          : `Codegraph daemon at ${skew.socketPath} runs another build that predates ` +
            `capability advertisement${builds}`,
      hint:
        "Proceeding would turn every op the daemon lacks into missing graph data. Restart the " +
        "codegraph daemon from the current build: reconnect the tea-rags MCP server or re-run " +
        "the index from the CLI — the main process drains and respawns a stale daemon — or stop " +
        "it via the pid file next to the socket. Then retry.",
      httpStatus: 503,
      cause,
    });
    this.missingOps = skew.missingOps;
  }
}

/**
 * The stale codegraph daemon acknowledged the graceful `shutdown` request but
 * did not exit within the wait window — its lifecycle files never cleared and
 * its pid stayed alive (bd tea-rags-mcp-ji56r). The daemon's own teardown is
 * hard-capped at ~3s, so exceeding the window means a wedged process.
 */
export class CodegraphDaemonExitTimeoutError extends InfraError {
  constructor(socketPath: string, timeoutMs: number, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_EXIT_TIMEOUT",
      message: `Stale codegraph daemon at ${socketPath} did not exit within ${timeoutMs}ms after a shutdown request`,
      hint:
        "The daemon process appears wedged and still holds the RW DuckDB lock. Inspect it " +
        "via the pid file next to the socket and stop it manually; a fresh daemon spawns on " +
        "the next write.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The codegraph daemon never accepted a connection within the connect window —
 * not running, crashed on start, or its socket is gone (bd tea-rags-mcp-a43tr).
 * Typed so optional codegraph consumers can tell "daemon unreachable" from a
 * programming error by class; the daemon log path is named because a bare
 * ENOENT says nothing about why the daemon is absent.
 */
export class CodegraphDaemonUnreachableError extends InfraError {
  constructor(
    target: { socketPath: string; connectTimeoutMs: number; detail: string; logPath: string },
    cause?: Error,
  ) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_UNREACHABLE",
      message:
        `DaemonGraphDbClient failed to connect to ${target.socketPath} within ` +
        `${target.connectTimeoutMs}ms: ${target.detail} — the daemon is not listening; ` +
        `its output is in ${target.logPath}`,
      hint:
        "The codegraph daemon is not running or crashed on start — its log (path above) says why. " +
        "Reconnecting the tea-rags MCP server (`/mcp reconnect`) or re-running the index spawns a fresh daemon.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The codegraph store cannot be reached from this process right now: the daemon
 * runs another build (stale / skewed), is wedged or unreachable, or the DuckDB
 * file will not open (lock held, unreadable). One family, so a consumer whose
 * codegraph read is OPTIONAL (find_symbol's collapsed-symbol fallback) degrades
 * exactly on it and lets every other failure propagate (bd tea-rags-mcp-a43tr).
 * A new acquire-failure class belongs in this union and the predicate below.
 */
export type CodegraphUnavailableError =
  | CodegraphDaemonStaleBuildError
  | CodegraphDaemonBuildSkewError
  | CodegraphDaemonExitTimeoutError
  | CodegraphDaemonUnreachableError
  | DuckDbOpenFailedError;

export function isCodegraphUnavailableError(err: unknown): err is CodegraphUnavailableError {
  return (
    err instanceof CodegraphDaemonStaleBuildError ||
    err instanceof CodegraphDaemonBuildSkewError ||
    err instanceof CodegraphDaemonExitTimeoutError ||
    err instanceof CodegraphDaemonUnreachableError ||
    err instanceof DuckDbOpenFailedError
  );
}

/**
 * DuckDB connection close failed while evicting a cached pool entry.
 * Distinct from open failure: the file already exists and the driver
 * rejected the close (rare — usually a hung connection). Unlink errors
 * are NOT surfaced as this class; they are swallowed by the pool because
 * `removeCollection` is idempotent and ENOENT means "already gone".
 */
export class DuckDbCloseFailedError extends InfraError {
  constructor(dbPath: string, cause?: Error) {
    super({
      code: "INFRA_DUCKDB_CLOSE_FAILED",
      message: `Failed to close DuckDB at ${dbPath}`,
      hint:
        "The DuckDB driver rejected the close call. Codegraph DB file may still be " +
        "locked until the process exits. Inspect cause for the underlying driver message.",
      httpStatus: 500,
      cause,
    });
  }
}
