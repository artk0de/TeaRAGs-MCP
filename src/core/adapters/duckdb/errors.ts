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
 *
 * `lockContention` separates the two (bd tea-rags-mcp-zgg62): only a held lock
 * clears by waiting, so it is the only failure an open retry may wait out. A
 * file that is not a database fails the same way on every attempt.
 */
export class DuckDbOpenFailedError extends InfraError {
  /** The open lost the file's lock to another process — the one retryable cause. */
  readonly lockContention: boolean;
  /**
   * The pid of the process holding the lock, as the driver names it
   * (`Conflicting lock is held in <exe> (PID <n>)`) — undefined when the open
   * failed for another reason or the driver did not say (bd tea-rags-mcp-hw27k).
   */
  readonly lockHolderPid: number | undefined;

  constructor(
    readonly dbPath: string,
    cause?: Error,
  ) {
    const lockContention = cause !== undefined && isDuckDbLockContentionMessage(cause.message);
    super({
      code: "INFRA_DUCKDB_OPEN_FAILED",
      message: `Failed to open DuckDB at ${dbPath}`,
      // No cause (the cold-start path) keeps the historical lock hint.
      hint:
        cause === undefined || lockContention
          ? "DuckDB is single-writer per file. Another tea-rags MCP process likely holds the lock — " +
            "stop the duplicate server or wait for it to idle out, then retry. Codegraph for this " +
            "collection is disabled in this process until the lock is released."
          : "The codegraph database file could not be opened (unreadable, or not a DuckDB database). " +
            "Remove it and re-index the project to rebuild the graph.",
      httpStatus: 503,
      cause,
    });
    this.lockContention = lockContention;
    this.lockHolderPid = lockContention ? parseDuckDbLockHolderPid(cause?.message ?? "") : undefined;
  }
}

/** The driver's wording for an open that lost the file lock to another process. */
function isDuckDbLockContentionMessage(message: string): boolean {
  return /Could not set lock on file|Conflicting lock is held/.test(message);
}

function parseDuckDbLockHolderPid(message: string): number | undefined {
  const match = /Conflicting lock is held in .*\(PID (\d+)\)/.exec(message);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The codegraph daemon of ANOTHER build that holds a collection's database file. */
export interface ForeignBuildDaemonLockHolder {
  pid: number;
  /** Its build-key directory under the daemon storage dir. */
  buildDir: string;
  /** Its build fingerprint (`<build dir>|<version>|<mtime>`), when its socket answered. */
  buildFingerprint: string | undefined;
}

/**
 * A collection's DuckDB file is held read-write by the codegraph daemon of
 * ANOTHER build, which still serves a connected client (bd tea-rags-mcp-hw27k).
 *
 * Build-keyed daemons (bd tea-rags-mcp-42hno) never share a socket, so two
 * builds on one machine run two daemons over the same collection files, and
 * DuckDB lets one process hold a file read-write. A foreign daemon nobody is
 * connected to is drained instead; this is raised only for one somebody is
 * still using — draining it would cut that session — once the open window has
 * run out. Named, rather than a bare open failure, because the remedy lies with
 * that other process, and waiting silently op after op is how a recompute lost
 * ten minutes to it.
 */
export class CodegraphDatabaseHeldByForeignDaemonError extends InfraError {
  readonly holderPid: number;

  constructor(
    readonly dbPath: string,
    readonly holder: ForeignBuildDaemonLockHolder,
    cause?: Error,
  ) {
    const build = holder.buildFingerprint?.split("|")[0] ?? holder.buildDir;
    super({
      code: "INFRA_CODEGRAPH_DB_HELD_BY_FOREIGN_DAEMON",
      // The remedy rides the message (bd tea-rags-mcp-a43tr): the pipeline log
      // and optional consumers quote the message, not the hint.
      message:
        `Codegraph database ${dbPath} is held by the codegraph daemon of another build ` +
        `(pid ${holder.pid}, build ${build}), which still has a client connected. ` +
        `Stop that session or daemon (kill ${holder.pid}) and retry`,
      hint:
        "Each tea-rags build runs its own codegraph daemon, and DuckDB lets only one process hold a " +
        "database file read-write. A foreign daemon with no client connected is drained automatically; " +
        "this one still serves a session (an MCP server or a `call` of that build). Finish or stop that " +
        "session, or point every session at one build, then re-run.",
      httpStatus: 503,
      cause,
    });
    this.holderPid = holder.pid;
  }
}

/**
 * Rebuild the typed error a daemon reported over the socket (bd
 * tea-rags-mcp-zgg62). The wire carries `{ name, message }` only, so a
 * `DuckDbOpenFailedError` raised in the daemon used to reach the client as a
 * plain `Error` and render as `UNKNOWN_ERROR`. The daemon also ships the
 * failed path and the driver's message, from which the same class — code,
 * hint and `lockContention` — is reconstructed. Any other name stays a plain
 * `Error` carrying that name.
 */
export function daemonErrorFromWire(wire: {
  name: string;
  message: string;
  dbPath?: string;
  cause?: string;
  holder?: ForeignBuildDaemonLockHolder;
}): Error {
  const cause = wire.cause !== undefined ? new Error(wire.cause) : undefined;
  if (wire.name === DuckDbOpenFailedError.name && wire.dbPath !== undefined) {
    return new DuckDbOpenFailedError(wire.dbPath, cause);
  }
  // The foreign-build holder rides the wire too (bd tea-rags-mcp-hw27k), so the
  // client that asked gets the named class, not a nameless `Error`.
  if (wire.name === CodegraphDatabaseHeldByForeignDaemonError.name && wire.dbPath !== undefined && wire.holder) {
    return new CodegraphDatabaseHeldByForeignDaemonError(wire.dbPath, wire.holder, cause);
  }
  return Object.assign(new Error(wire.message), { name: wire.name });
}

/** The wire shape of an error — `daemonErrorFromWire`'s inverse. */
export function daemonErrorToWire(err: Error): {
  name: string;
  message: string;
  dbPath?: string;
  cause?: string;
  holder?: ForeignBuildDaemonLockHolder;
} {
  if (err instanceof CodegraphDatabaseHeldByForeignDaemonError) {
    return {
      name: err.name,
      message: err.message,
      dbPath: err.dbPath,
      holder: err.holder,
      ...(err.cause ? { cause: err.cause.message } : {}),
    };
  }
  if (err instanceof DuckDbOpenFailedError) {
    return {
      name: err.name,
      message: err.message,
      dbPath: err.dbPath,
      ...(err.cause ? { cause: err.cause.message } : {}),
    };
  }
  return { name: err.name, message: err.message };
}

/**
 * A READ addressed a collection that has no codegraph database on disk (bd
 * tea-rags-mcp-kn2cb). Readers never create one: the daemon opens collections
 * read-write, so a proxied read used to materialize an empty file, after which
 * the collection claimed a graph it never had. Optional read consumers treat
 * this class as "codegraph never ran here" and answer empty.
 */
export class CodegraphDatabaseMissingError extends InfraError {
  constructor(dbPath: string) {
    super({
      code: "INFRA_CODEGRAPH_DATABASE_MISSING",
      message: `No codegraph database at ${dbPath}`,
      hint: "The collection was not indexed with codegraph. Enable CODEGRAPH_ENABLED and re-index to build it.",
      httpStatus: 404,
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
 * The codegraph daemon REFUSED a client-requested shutdown drain because
 * another connection still had writes in flight (bd tea-rags-mcp-zgcmo).
 *
 * A drain from a foreign build — `npm link` re-pointed at another checkout, or
 * `npm i -g` over an active link — used to kill the daemon mid-write and fail
 * the OTHER sessions' in-flight codegraph runs with `write EPIPE`. The daemon
 * now denies such a drain and stays up; this is what the DRAINING side settles
 * with, so the retry/defer decision stays with the side that asked for it.
 * 503: the daemon is healthy — the drain was merely denied for now.
 */
export class CodegraphDaemonDrainRefusedError extends InfraError {
  constructor(refusal: { socketPath: string }, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_DRAIN_REFUSED",
      // The remedy rides the message (bd tea-rags-mcp-a43tr): optional consumers
      // quote the message when they degrade.
      message:
        `Codegraph daemon at ${refusal.socketPath} refused the shutdown drain: another connection ` +
        "still has writes in flight, so nothing was drained. Retry once the other session's writes finish",
      hint:
        "Drains usually come from a foreign build (`npm link` re-pointed at another checkout, or " +
        "`npm i -g` over an active link); draining used to kill the daemon mid-write and fail the " +
        "other session with EPIPE. The daemon stays up and the in-flight writes finish untouched — " +
        "re-run the operation, or point every session at one build (`npm run build && npm link` in " +
        "the checkout you intend to use) and restart the MCP server (`/mcp reconnect`) so the skew " +
        "disappears.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * No codegraph daemon is running for THIS process's build (bd
 * tea-rags-mcp-42hno): the build-keyed socket has no listener, and this pool
 * cannot spawn one. Worker-thread pools rebuild from serializable config and
 * have no respawn hook — provisioning a daemon is a main-thread-pool
 * responsibility, ordered before the first worker fork. Distinct from
 * `CodegraphDaemonUnreachableError` (which names a socket that exists but
 * never accepted): this names the OWN-KEY MISS, so a worker surfaces
 * "provisioning did not reach me" instead of silently sharing whatever other
 * build happens to be running. 503: retryable once the main thread spawns.
 */
export class CodegraphDaemonBuildUnavailableError extends InfraError {
  constructor(target: { socketPath: string; buildKey: string }, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_BUILD_UNAVAILABLE",
      message:
        `No codegraph daemon is running for this process's build ` +
        `(key ${target.buildKey}, socket ${target.socketPath}) and this pool cannot spawn one`,
      hint:
        "Provisioning a daemon is a main-thread responsibility: run one index step on the main " +
        "thread (its pool cold-spawns the daemon on first acquire) or reconnect the tea-rags MCP " +
        "server (`/mcp reconnect`), then retry. Worker-thread pools deliberately do NOT share " +
        "another build's daemon — an own-build daemon is what guarantees op compatibility.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * A codegraph daemon refused to start because another live daemon already owns
 * its build-key directory (bd tea-rags-mcp-imgjx). Raised by `runDaemon` after
 * it has asked its process to exit cleanly: the losing side of a spawn race must
 * not open a DuckDB file or take over the socket — an unreachable twin holding a
 * collection's RW lock is exactly what stalled the reachable daemon's opens for
 * a full idle-eviction window. Never crosses the socket; it only tells an
 * in-process caller why no daemon handle came back.
 */
export class CodegraphDaemonOwnedElsewhereError extends InfraError {
  constructor(owner: { buildDir: string; ownerPid: number | undefined }, cause?: Error) {
    super({
      code: "INFRA_CODEGRAPH_DAEMON_OWNED_ELSEWHERE",
      message:
        `Codegraph daemon key directory ${owner.buildDir} is already owned by live daemon ` +
        `pid ${owner.ownerPid ?? "unknown"}; this daemon did not start`,
      hint:
        "Nothing to do: clients reach the owning daemon over the same socket. A second daemon of " +
        "the same build only starts when two spawns race, and the loser exits on its own.",
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * The wire carries only `{ name, message }` (see `DaemonResponse`), so a
 * refusal cannot survive the socket as a class instance — the pool recognizes
 * it by the error name the daemon put on the response.
 */
export function isDaemonDrainRefusal(err: unknown): err is Error {
  return err instanceof Error && err.name === CodegraphDaemonDrainRefusedError.name;
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
 * Raised by the pool's build handshake, and by a client whose replay after a
 * lost connection meets such a daemon (`DaemonGraphDbClient#describeRefusal`).
 *
 * The same class refuses each WRITE of a stale client that did proceed
 * (`refusedWriteOp`): proceeding is read-only, because the capability check
 * matches op names and a write whose payload shape moved under an unchanged
 * name would land in the store unnoticed.
 *
 * `missingOps` is empty when the daemon advertises no op list at all, and for
 * a refused write.
 */
export class CodegraphClientStaleBuildError extends InfraError {
  readonly missingOps: readonly string[];

  constructor(
    skew: {
      socketPath: string;
      clientFingerprint: string;
      daemonFingerprint: string;
      missingOps: readonly string[];
      /** The write refused because this client proceeded read-only. */
      refusedWriteOp?: string;
    },
    cause?: Error,
  ) {
    const unserved =
      skew.refusedWriteOp !== undefined
        ? `serves this process read-only, so write op ${skew.refusedWriteOp} was refused`
        : skew.missingOps.length > 0
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
  | CodegraphDaemonDrainRefusedError
  | CodegraphDaemonBuildUnavailableError
  | CodegraphDatabaseHeldByForeignDaemonError
  | DuckDbOpenFailedError;

export function isCodegraphUnavailableError(err: unknown): err is CodegraphUnavailableError {
  return (
    err instanceof CodegraphDaemonStaleBuildError ||
    err instanceof CodegraphClientStaleBuildError ||
    err instanceof CodegraphDaemonBuildSkewError ||
    err instanceof CodegraphDaemonExitTimeoutError ||
    err instanceof CodegraphDaemonUnreachableError ||
    err instanceof CodegraphDaemonUnresponsiveError ||
    err instanceof CodegraphDaemonDrainRefusedError ||
    err instanceof CodegraphDaemonBuildUnavailableError ||
    err instanceof CodegraphDatabaseHeldByForeignDaemonError ||
    err instanceof DuckDbOpenFailedError
  );
}

/**
 * A streamed DuckDB result ended before the rows it had to deliver (bd
 * tea-rags-mcp-sgo8v). The driver cannot say so itself: a streaming result
 * whose connection ran another statement, or was closed, answers `fetchChunk`
 * with `null` — the same answer as the true end — and the C API's
 * `duckdb_result_error` is not exposed to Node. Consumers of a stream
 * (`streamAdjacency` → cycles + PageRank) would otherwise compute and persist
 * metrics over the first chunk of the graph with no error anywhere.
 *
 * `reason: "truncated"` — the drain yielded fewer rows than the same query
 * counts in the stream's own snapshot; `"closed"` — the session closed while
 * the stream was still being drained.
 */
export class DuckDbStreamIncompleteError extends InfraError {
  constructor(
    dbPath: string,
    detail: { reason: "truncated" | "closed"; yielded: number; expected?: number },
    cause?: Error,
  ) {
    const count =
      detail.expected === undefined ? `${detail.yielded} rows` : `${detail.yielded} of ${detail.expected} rows`;
    super({
      code: "INFRA_DUCKDB_STREAM_INCOMPLETE",
      message: `DuckDB stream on ${dbPath} ended ${detail.reason === "closed" ? "by a session close" : "early"} after ${count}`,
      hint:
        "A streamed read stopped before its result was complete, so nothing computed from it was " +
        "persisted. Re-run the operation; if it repeats, inspect cause for the driver message.",
      httpStatus: 500,
      cause,
    });
  }
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

/**
 * A codegraph storage compaction (bd tea-rags-mcp-dvzdm) did not complete.
 *
 * `stage` says how far it got, and therefore what is on disk:
 * - `copy` — the staged copy could not be written or did not match the live
 *   database (`detail` names what differed); the staging file was removed and
 *   the live file never moved.
 * - `publish` — the atomic rename of the staged copy over the live file
 *   failed; the live file is still the original and the client still has it
 *   open.
 * - `reopen` — the compacted file IS published, but opening it failed; the
 *   client reports no open file, so its pool retires it and the next acquire
 *   opens the path afresh.
 *
 * A compaction is best-effort: the caller logs this and a later run retries.
 */
export class CodegraphStorageCompactionFailedError extends InfraError {
  readonly stage: "copy" | "publish" | "reopen";

  constructor(dbPath: string, stage: "copy" | "publish" | "reopen", cause?: Error, detail?: string) {
    super({
      code: "INFRA_CODEGRAPH_STORAGE_COMPACTION_FAILED",
      message: `Codegraph storage compaction of ${dbPath} failed at the ${stage} stage${detail ? `: ${detail}` : ""}`,
      hint:
        stage === "reopen"
          ? "The compacted database is in place but could not be opened; the next codegraph operation " +
            "reopens it. Inspect cause for the driver message."
          : "The original database file is untouched. The next index run retries the compaction; " +
            "inspect cause for the driver or filesystem message.",
      httpStatus: 500,
      cause,
    });
    this.stage = stage;
  }
}

/**
 * A codegraph snapshot export (bd tea-rags-mcp-xi2r9, WTO-7) did not produce a
 * database at the target path. An export never touches the live database, so
 * whatever the stage, it is intact and still open.
 *
 * `stage` says how far it got:
 * - `unsupported` — the codegraph daemon holding the database predates the op.
 *   Only the holder can read what its WAL keeps, so nothing was copied.
 * - `copy` — the staged copy could not be written or did not match the live
 *   database (`detail` names what differed); the staging files were removed.
 * - `publish` — the rename of the staged copy onto the target failed; the
 *   staging files were removed and an existing target is unchanged.
 */
export class CodegraphSnapshotExportFailedError extends InfraError {
  readonly stage: "unsupported" | "copy" | "publish";

  constructor(
    dbPath: string,
    targetPath: string,
    stage: "unsupported" | "copy" | "publish",
    cause?: Error,
    detail?: string,
  ) {
    super({
      code: "INFRA_CODEGRAPH_SNAPSHOT_EXPORT_FAILED",
      message: `Codegraph snapshot of ${dbPath} to ${targetPath} failed at the ${stage} stage${detail ? `: ${detail}` : ""}`,
      hint:
        stage === "unsupported"
          ? "The running codegraph daemon is from an older build without snapshot export; it is replaced " +
            "once its sessions end. The live database is untouched."
          : "The live database is untouched and the export is safe to retry. Inspect cause for the driver " +
            "or filesystem message.",
      httpStatus: 500,
      cause,
    });
    this.stage = stage;
  }
}
