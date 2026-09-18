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
 * means one other session on another build tree respawns its daemon after each
 * drain — two builds contending for one daemon, which retrying will never fix.
 * A client that merely predates the on-disk build never reaches this error
 * (bd tea-rags-mcp-1wr7p): the handshake detects it before draining, unless
 * its own build tree could not be read.
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
          : `The same build came back after every restart (${distinct.join(", ")}), and it is not ` +
            "the build on disk under this process — a server that merely predates the last rebuild " +
            "is detected before any drain and never gets here. The usual cause is another live " +
            "tea-rags session running from another build tree (a different checkout or worktree) " +
            "that respawns its daemon after each drain: two builds contending for the one " +
            "machine-wide daemon. `npm link` re-pointed at another checkout, or `npm i -g` over an " +
            "active link, splits sessions the same way — a running process keeps the tree it " +
            "resolved at start while new sessions launch from the new one. Let the other session " +
            "finish, or point every session at one build (`npm run build && npm link` in the " +
            "checkout you intend to use) and restart the MCP server (`/mcp reconnect`). Only when " +
            "this process's own build tree could not be read (removed or mid-rewrite) can this " +
            "server itself be the stale side — reconnecting it covers that case too.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * THIS process is the stale side of a build mismatch, and the up-to-date daemon
 * cannot serve every op its old code requires (bd tea-rags-mcp-1wr7p).
 *
 * The daemon reports the build that is on disk now; this process loaded an
 * older one before a rebuild, `npm link` or `npm i -g` upgrade. Draining cannot
 * converge — every respawn launches that same on-disk build — and each drain
 * would cut every session already on it, so the daemon is left running and
 * only reloading this process helps. When the daemon DOES advertise every
 * required op the pool proceeds and this error is never raised.
 *
 * `missingOps` is empty when the daemon advertises no op list at all.
 */
export class CodegraphClientStaleBuildError extends InfraError {
  readonly missingOps: readonly string[];

  constructor(
    skew: {
      socketPath: string;
      clientFingerprint: string;
      daemonFingerprint: string;
      missingOps: readonly string[];
    },
    cause?: Error,
  ) {
    const unserved =
      skew.missingOps.length > 0
        ? `lacks op${skew.missingOps.length === 1 ? "" : "s"} ${skew.missingOps.join(", ")} this process requires`
        : "does not advertise the ops it serves";
    super({
      code: "INFRA_CODEGRAPH_CLIENT_STALE_BUILD",
      // The remedy rides the message (bd tea-rags-mcp-a43tr): optional consumers
      // quote the message when they degrade.
      message:
        `This tea-rags process runs build ${skew.clientFingerprint}, but the build on disk and the ` +
        `codegraph daemon at ${skew.socketPath} are ${skew.daemonFingerprint}, and that daemon ${unserved} — ` +
        "restart the tea-rags MCP server (`/mcp reconnect`) to load the current build",
      hint:
        "This process predates the last rebuild, `npm link` or `npm i -g` upgrade; the daemon is the " +
        "up-to-date peer, so it was left running — draining it would only respawn the same build and " +
        "disconnect every session already on it. tea-rags does not restart its own server process: " +
        "reconnect the MCP server (`/mcp reconnect`) or restart the client that launched it.",
      httpStatus: 503,
      cause,
    });
    this.missingOps = skew.missingOps;
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
 * The daemon went silent with calls pending (bd tea-rags-mcp-f924y): nothing —
 * no response, no answer to a liveness probe — arrived within the liveness
 * bound. A slow op does not trip this; a live daemon answers probes while it
 * works. A wedged daemon, or a connection that died without closing, does.
 */
export class CodegraphDaemonUnresponsiveError extends InfraError {
  constructor(target: { socketPath: string; silentForMs: number; pendingCalls: number }) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_UNRESPONSIVE",
      message:
        `Codegraph daemon at ${target.socketPath} answered nothing for ${target.silentForMs}ms — ` +
        `not even a liveness probe — with ${target.pendingCalls} call(s) pending`,
      hint:
        "The daemon is wedged or its connection is dead. Its pid is in codegraph-daemon.pid next to the " +
        "socket and its output in codegraph-daemon.log; stopping it lets the next run spawn a fresh one.",
      httpStatus: 503,
    });
  }
}

/**
 * The daemon stopped a request because the connection that sent it closed
 * (bd tea-rags-mcp-f924y) — a write still queued behind another client's, or a
 * graph analysis at its next phase boundary. Nobody reads the response of a
 * closed connection, so this never reaches a client; it exists so the daemon's
 * never-throw envelope names why the op did not run. Deliberately outside
 * `CodegraphUnavailableError`: it says nothing about whether the store is up.
 */
export class CodegraphDaemonRequestAbortedError extends InfraError {
  constructor(op: string) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_REQUEST_ABORTED",
      message: `Codegraph daemon dropped "${op}": the client connection that sent it closed`,
      hint:
        "The requesting process exited or closed its socket before the op ran to completion. " +
        "The next index run redoes the work; nothing needs to be done by hand.",
      httpStatus: 499,
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
  | CodegraphClientStaleBuildError
  | CodegraphDaemonBuildSkewError
  | CodegraphDaemonExitTimeoutError
  | CodegraphDaemonUnreachableError
  | CodegraphDaemonUnresponsiveError
  | DuckDbOpenFailedError;

export function isCodegraphUnavailableError(err: unknown): err is CodegraphUnavailableError {
  return (
    err instanceof CodegraphDaemonStaleBuildError ||
    err instanceof CodegraphClientStaleBuildError ||
    err instanceof CodegraphDaemonBuildSkewError ||
    err instanceof CodegraphDaemonExitTimeoutError ||
    err instanceof CodegraphDaemonUnreachableError ||
    err instanceof CodegraphDaemonUnresponsiveError ||
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
