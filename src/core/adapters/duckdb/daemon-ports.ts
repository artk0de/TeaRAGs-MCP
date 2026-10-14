/**
 * The daemon contracts the duckdb ROOT consumes (bd tea-rags-mcp-89k7k.35,
 * H4a1). `GraphDbClientPool` and `LockContendedOpenRetry` sit at the adapter
 * root while the classes that satisfy these contracts live under `daemon/` —
 * so the TYPES the root reads are owned HERE, the daemon classes implement
 * them, and the daemon files re-export them (child -> parent, the allowed
 * direction). That keeps the root's dependency on the daemon one-way at the
 * type level: the pool's option fields and callbacks name these ports, never
 * a `daemon/` symbol.
 *
 * Since H4a2 the pool consumes the daemon VALUE side the same way: its
 * `daemonRouting` option names {@link DaemonRouting}, and whoever constructs
 * the pool builds that routing from the daemon classes (`createDaemonRouting`
 * in `daemon/index.ts`). The pool itself imports nothing from `daemon/`.
 */

import type { CollectionGraphHandle } from "../../contracts/types/codegraph-pool.js";
import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import type { DuckDbOpenFailedError, ForeignBuildDaemonLockHolder } from "./errors.js";

export interface CodegraphDaemonPaths {
  /**
   * The base storage dir `getDaemonPaths` was called with (bd
   * tea-rags-mcp-42hno). NOT the directory the files sit in — that is
   * `buildDir`. For the legacy and for-key-dir views the two coincide.
   */
  storageDir: string;
  /**
   * The directory the lifecycle files actually sit in: `<storageDir>/<build
   * key>` for the keyed view, the plain dir for the legacy / for-key-dir
   * views. A daemon's cleanup and the orphan sweep remove THIS directory.
   */
  buildDir: string;
  socketPath: string;
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
  /**
   * Single-instance ownership lock of the key directory (bd tea-rags-mcp-imgjx):
   * held by the owning daemon for its whole lifetime, stamped with its pid. See
   * `claimDaemonOwnership`.
   */
  ownerFile: string;
  /** Where the spawned daemon's stdout + stderr are recorded. */
  logFile: string;
}

/**
 * How a client process's build relates to the build on disk, and therefore
 * which key directory it addresses (bd tea-rags-mcp-llrja):
 * - `own-build` — loaded == on disk (or the fingerprint env override): its own
 *   build's key dir, exactly `getDaemonPaths`;
 * - `on-disk-build` — the process predates a rebuild / `npm link` / upgrade:
 *   the ON-DISK build's key dir, because every daemon spawned from this tree
 *   runs that build and keys itself by it. The build handshake then settles
 *   what the stale process may do there (bd tea-rags-mcp-1wr7p);
 * - `build-tree-gone` — the loaded tree is unreadable: nothing can be spawned
 *   from it, so only a still-running daemon of the loaded build is reachable.
 */
export type CodegraphDaemonClientAddressing = "own-build" | "on-disk-build" | "build-tree-gone";

/** Which daemon a client process talks to right now — see `resolveDaemonClientTarget`. */
export interface CodegraphDaemonClientTarget {
  readonly addressing: CodegraphDaemonClientAddressing;
  readonly paths: CodegraphDaemonPaths;
  /** The build this process loaded. */
  readonly loadedFingerprint: string;
  /** The build on disk now; undefined when the tree is gone. */
  readonly onDiskFingerprint: string | undefined;
}

/**
 * Build + capability handshake restart wiring — `GraphDbClientPoolOptions.daemonRestart`
 * documents when it applies.
 */
export interface CodegraphDaemonRestartWiring {
  /** Cold-spawn hook — wired to `ensureCodegraphDaemon` by the bootstrap factory. */
  respawn?: () => void;
  /** Override the module-captured loaded fingerprint (tests). */
  buildFingerprint?: string;
  /**
   * Override the reader of the build fingerprint on disk NOW (tests) — what a
   * daemon respawned from this process's build tree would report. Defaults to
   * `readOnDiskBuildFingerprint`.
   */
  readOnDiskBuildFingerprint?: () => string | undefined;
  /** Bound on the wait for the stale daemon's exit (default 10s). */
  exitTimeoutMs?: number;
  /** Lifecycle-file poll interval while waiting for the exit. */
  pollIntervalMs?: number;
  /**
   * Drain-respawn attempts before the typed error (default 3, floor 1). Kept
   * small on purpose: it widens the window for losing a spawn race, it is not a
   * wait-until-healthy loop.
   */
  maxRestartAttempts?: number;
  /** Base delay between restart attempts; jittered (default 250ms). */
  restartDelayMs?: number;
}

/** How a lock held by another build's daemon was settled. */
export type ForeignBuildLockSettlement =
  /** The holder is not a codegraph daemon of another build — plain retry applies. */
  | { kind: "notForeignBuildDaemon" }
  /** The holder served nobody and has exited; the open may be retried at once. */
  | { kind: "drained"; holder: ForeignBuildDaemonLockHolder }
  /**
   * The holder, still serving a client, closed this one idle collection on
   * request and stays up (bd tea-rags-mcp-8noie); the open may be retried at once.
   */
  | { kind: "released"; holder: ForeignBuildDaemonLockHolder }
  /** The holder is in use, refused the drain, or could not be drained; it stays up. */
  | {
      kind: "held";
      holder: ForeignBuildDaemonLockHolder;
      reason: "clientConnected" | "drainRefused" | "unreachable" | "exitTimeout";
    };

/**
 * Settles a DuckDB open that lost the file lock to another build's codegraph
 * daemon (bd tea-rags-mcp-hw27k) — the port `GraphDbClientPoolOptions.foreignBuildLockArbiter`
 * and `LockContendedOpenRetryOptions.foreignBuildLockArbiter` name; the daemon's
 * `ForeignBuildDaemonLockArbiter` implements it.
 */
export interface ForeignBuildLockArbiter {
  /**
   * Settle `openError` — a lock-contention open failure of
   * `physicalCollectionName` — against its holder.
   */
  settle: (
    openError: DuckDbOpenFailedError,
    physicalCollectionName: PhysicalCollectionName,
  ) => Promise<ForeignBuildLockSettlement>;
  /**
   * Whether `openError` is still the lock of `holder`: it names the same pid,
   * and that pid is alive and registered under the same build-key dir (bd
   * tea-rags-mcp-89k7k.35.27).
   */
  isStillHeldBy: (openError: DuckDbOpenFailedError, holder: ForeignBuildDaemonLockHolder) => boolean;
  /**
   * The holder with its build fingerprint filled in, for naming it in an error.
   * Best-effort: an unreachable socket leaves the fingerprint unknown.
   */
  describe: (
    holder: ForeignBuildDaemonLockHolder,
    physicalCollectionName: PhysicalCollectionName,
  ) => Promise<ForeignBuildDaemonLockHolder>;
}

/**
 * Who replaced the file. `caller` means the daemon did nothing and the caller
 * must act on the files itself:
 * - `no-daemon` — no daemon of this build is running, so no client to drain.
 * - `daemon-unreachable` — its pid is alive but its socket did not accept.
 * - `op-unsupported` — a daemon from an older build without the op.
 */
export type DaemonDatabaseReplacement =
  | { handledBy: "daemon"; evicted: boolean }
  | { handledBy: "caller"; reason: "no-daemon" | "daemon-unreachable" | "op-unsupported" };

/**
 * Asks the running codegraph daemon to replace a collection's database file —
 * remove it, or clone another collection over it — under the daemon pool's path
 * lease (bd tea-rags-mcp-r4veq): only the pool that holds the clients can drain
 * them. The port the pool's replacement callback names; the daemon's
 * `DaemonDatabaseFileReplacer` implements it.
 */
export interface CodegraphDatabaseFileReplacer {
  /** Remove `target`'s database through the daemon's pool. */
  removeDatabase: (target: PhysicalCollectionName) => Promise<DaemonDatabaseReplacement>;
  /** Clone `source`'s database over `target` through the daemon's pool. */
  cloneDatabase: (source: PhysicalCollectionName, target: PhysicalCollectionName) => Promise<DaemonDatabaseReplacement>;
}

/**
 * The per-collection daemon clients a daemon-mode pool routes its acquires
 * through — the member set is exactly what `GraphDbClientPool` calls on
 * `DaemonCollectionClientCache`: the shared handle over the ONE cached
 * `DaemonGraphDbClient` per collection, and the teardown that closes every
 * cached socket.
 */
export interface DaemonCollectionClientCachePort {
  /**
   * Handle over the single cached daemon client for the collection (its
   * `close()` is a no-op — the routing owns the socket, not the caller).
   */
  acquireHandle: (physicalCollectionName: PhysicalCollectionName) => Promise<CollectionGraphHandle>;
  /** Close every cached daemon socket; idempotent, close failures swallowed. */
  closeAll: () => Promise<void>;
}

/**
 * How a daemon-mode `GraphDbClientPool` reaches the daemon (bd
 * tea-rags-mcp-89k7k.35, H4a2): the cached per-collection clients its
 * `acquireWrite` / `acquireReader` route through, and the factory for the
 * short-lived control connection a database-file replacement sends its op
 * over. The pool CONSUMES this; constructing it from the daemon classes is
 * the composition root's job (`createDaemonRouting` in `daemon/index.ts`), so
 * `pool.ts` imports nothing from `daemon/` — value or type.
 */
export interface DaemonRouting {
  clients: DaemonCollectionClientCachePort;
  /** The replacer bound to `socketPath` — this build's daemon, resolved by the pool's addressing options. */
  replacerFor: (socketPath: string) => CodegraphDatabaseFileReplacer;
}
