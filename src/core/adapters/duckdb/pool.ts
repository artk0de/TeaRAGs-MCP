/**
 * Per-collection DuckDB pool for codegraph isolation: one
 * `<dataDir>/codegraph/<collectionName>.duckdb` per collection, opened lazily,
 * migrated once, cached.
 *
 * Per-file because DuckDB is single-writer per file (a shared DB lets one
 * process's lock disable codegraph for every project) and the `cg_symbols_*`
 * tables carry no collection column (two projects would collide on PKs). No cap
 * on open instances; `release(collectionName)` exists for tests.
 *
 * A cached client is handed out only while its path still names the database
 * file it opened — see `acquire` (bd tea-rags-mcp-amh78).
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CallResolver, GlobalSymbolTable, GraphDbClient } from "../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import type { DatabaseMigrationApplier } from "../../contracts/types/migration.js";
import { isDebug } from "../../infra/runtime.js";
import { DuckDbGraphClient } from "./client.js";
import { CodegraphDbFiles, sanitiseCollectionName } from "./codegraph-db-files.js";
import { getBuildFingerprint, readOnDiskBuildFingerprint } from "./daemon/build-fingerprint.js";
import type { DaemonCapabilityVerdict, DaemonGraphDbClient } from "./daemon/client.js";
import {
  daemonPathsForKeyDir,
  DEFAULT_EXIT_TIMEOUT_MS,
  getBuildKey,
  getLegacyDaemonPaths,
  isDaemonPidAlive,
  readDaemonPid,
  unlinkDaemonFiles,
  waitForDaemonExit,
} from "./daemon/lifecycle.js";
import {
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonBuildUnavailableError,
  CodegraphDaemonDrainRefusedError,
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
  isDaemonDrainRefusal,
} from "./errors.js";
import { purgeStaleSpills } from "./spill-files.js";

/**
 * Drain-respawn attempts before `CodegraphDaemonStaleBuildError`: enough to lose
 * a spawn race to another MCP process, few enough that a respawn hook launching a
 * stale binary fails fast (bd tea-rags-mcp-ryoqn) — see `connectWithBuildHandshake`.
 */
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;

/** Base delay between restart attempts; jittered per attempt. */
const DEFAULT_RESTART_DELAY_MS = 250;

/** Delay between `openRetry` attempts when the option leaves it unset. */
const DEFAULT_OPEN_RETRY_INTERVAL_MS = 1_000;

/**
 * A respawn-capable pool replaces a daemon from another build, or one that does
 * not advertise every op this client requires (bd tea-rags-mcp-39xca.4).
 */
function needsDaemonReplacement(verdict: DaemonCapabilityVerdict): boolean {
  return verdict.buildMismatch || verdict.missingRequiredOps.length > 0;
}

/** Debug-line reason a handshake did not settle. */
function describeDaemonSkew(verdict: DaemonCapabilityVerdict, clientFingerprint: string): string {
  const builds = `(daemon=${verdict.daemonFingerprint ?? "unknown"}, client=${clientFingerprint})`;
  const missing =
    verdict.missingRequiredOps.length > 0 ? `lacks required ops ${verdict.missingRequiredOps.join(", ")} ` : "";
  return verdict.buildMismatch ? `build mismatch ${missing}${builds}` : `${missing}${builds}`;
}

/**
 * Initialiser hook the pool calls once per newly-opened collection client, so
 * the codegraph domain can hydrate the symbol table — the pool does not import
 * the in-memory symbol-table implementation.
 */
export type CollectionInitHook = (args: {
  collectionName: PhysicalCollectionName;
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}) => Promise<void>;

export type SymbolTableFactory = () => GlobalSymbolTable;

export interface GraphDbClientPoolOptions {
  /** Root directory; per-collection files go in `<rootDir>/codegraph/`. */
  rootDir: string;
  /** Factory for the per-collection in-memory symbol table. */
  symbolTableFactory: SymbolTableFactory;
  /** Called once per collection after migrations apply; hydrates the symbol table. */
  initHook?: CollectionInitHook;
  /**
   * Per-DuckDB resource ceiling applied at init on every opened collection (see
   * `DuckDbGraphClientOptions.resources`). `tempDirectory` defaults under
   * `rootDir`, so all pool-managed collections share one spill directory.
   */
  resources?: {
    memoryLimit?: string;
    threads?: number;
    tempDirectory?: string;
    preserveInsertionOrder?: boolean;
  };
  /**
   * Applies pending graph DDL to a freshly opened collection. Required: the
   * migration steps live in `domains/maintenance/migration/database/`, which
   * `adapters` may not import, so every construction site must pass one.
   */
  applyMigrations: DatabaseMigrationApplier;
  /**
   * Called after the pool closes — or tries to close — the cached read-write
   * client it held for a collection: a stale client being replaced, `release`,
   * `removeCollection`, `closeAll`. Whoever keeps per-collection state keyed by
   * that handle drops it here; the daemon wires its `DaemonMemoryGovernor`
   * (bd tea-rags-mcp-amh78).
   */
  onCollectionClientClosed?: (collectionName: PhysicalCollectionName) => void;
  /**
   * Per-collection idle eviction (bd tea-rags-mcp-nlls). When wired, a cached
   * read-write client whose collection has had no op for `idleMs` — and none
   * in flight — is closed (releasing the per-process RW lock on its database
   * file) and dropped from the cache; the next acquire lazily re-opens. The
   * daemon wires this because its process-level idle timer watches SOCKET
   * clients, so without it every connection the daemon ever opened holds its
   * file lock until the daemon dies. Pools without the option keep the
   * close-on-process-exit behaviour unchanged.
   */
  idleEviction?: GraphDbClientPoolIdleEviction;
  /**
   * Unix socket of the running codegraph daemon. When set, `acquireWrite` and
   * `acquireReader` route through a `DaemonGraphDbClient` — the daemon holds the
   * RW DuckDB lock, so concurrent MCP processes never contend on it. Absent
   * (direct/test mode): in-process handles.
   */
  daemonSocketPath?: string;
  /**
   * Base daemon lifecycle storage dir (bd tea-rags-mcp-42hno). When set, the
   * pool checks — once per connect, a couple of `existsSync` in steady state —
   * for a LEGACY (pre-keying) daemon layout in that dir and migrates it out of
   * the way: a live legacy daemon is drained through the existing flow (the
   * zgcmo guard protects its in-flight writers), a dead one is unlinked
   * directly. The bootstrap factory wires the same dir it passes the spawner;
   * worker-thread pools omit it (provisioning ran on the main thread before
   * they forked) and so never touch a legacy layout.
   */
  daemonStorageDir?: string;
  /**
   * Bounded retry for the collection OPEN (bd tea-rags-mcp-42hno). When set,
   * a `DuckDbOpenFailedError` from the open is retried every `intervalMs`
   * until `maxMs` elapses, then the last error rethrown. The DAEMON wires it
   * (its pool is the only one that opens files in daemon mode): with two
   * build-keyed daemons on one machine, both serve the same on-disk
   * collections, so a loser's open waits out the winner's idle eviction
   * (nlls) instead of failing the op. Without it the open fails immediately.
   */
  openRetry?: {
    /** Give up (rethrowing the last `DuckDbOpenFailedError`) after this long. */
    maxMs: number;
    /** Delay between open attempts (default 1s). */
    intervalMs?: number;
  };
  /**
   * Build + capability handshake restart wiring, daemon mode only (bd
   * tea-rags-mcp-ji56r, 39xca.4). A daemon from another build, or one missing a
   * required op, is drained, its exit awaited, `respawn` invoked and the
   * connection retried up to `maxRestartAttempts`. A pre-fingerprint peer
   * proceeds unchanged, and so does — read-only — a daemon of the build on disk
   * that this process predates (bd tea-rags-mcp-1wr7p). Without `respawn` the pool never
   * drains — see `connectWithBuildHandshake`.
   */
  daemonRestart?: {
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
     * small on purpose: it widens the window for losing a spawn race, it is not
     * a wait-until-healthy loop.
     */
    maxRestartAttempts?: number;
    /** Base delay between restart attempts; jittered (default 250ms). */
    restartDelayMs?: number;
  };
}

/**
 * Per-collection idle-eviction tuning (bd tea-rags-mcp-nlls). `pollMs` mirrors
 * the daemon idle watcher's 5s cadence by default.
 */
export interface GraphDbClientPoolIdleEviction {
  /** Evict a collection's cached client after this long with no op. */
  idleMs: number;
  /** How often the eviction pass runs. */
  pollMs?: number;
}

/**
 * The database file a cached client opened, as `dev` + `ino` read right after
 * the open. A path check alone cannot tell the file the client writes into from
 * a different database put at the same path since (bd tea-rags-mcp-amh78).
 */
interface OpenedDatabaseFile {
  dev: bigint;
  ino: bigint;
}

interface PoolEntry {
  graphDb: DuckDbGraphClient;
  symbolTable: GlobalSymbolTable;
  /** What `holdsOpenedDatabaseFile` compares the path against on every cached return. */
  databaseFile: OpenedDatabaseFile;
}

/**
 * Cached daemon-mode entry: the raw `DaemonGraphDbClient` (whose real `close`
 * the pool calls in `closeAll`) plus a stable no-op-close wrapper handed to
 * callers. Caching the wrapper keeps handle identity stable across acquires.
 */
interface DaemonClientEntry {
  client: DaemonGraphDbClient;
  wrapped: GraphDbClient;
  /**
   * ONE in-memory symbol table per collection, shared by every acquire: pass-2
   * resolves cross-file calls against it, so a table per acquire loses every
   * other file's symbols and collapses method-edge resolution. Mirrors
   * `PoolEntry.symbolTable`.
   */
  symbolTable: GlobalSymbolTable;
}

export interface CollectionGraphHandle {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}

export class GraphDbClientPool {
  /**
   * Path layout of the per-collection DuckDB files. Delegated rather than
   * duplicated so the purge path — which must NOT construct a pool, see
   * `CodegraphDbFiles` — resolves identical names.
   */
  private readonly dbFiles: CodegraphDbFiles;
  private readonly clients = new Map<PhysicalCollectionName, PoolEntry>();
  /**
   * In-flight open promises so concurrent first-callers for the same
   * collection share a single init pass (avoids racing migrations on
   * the same file).
   */
  private readonly inflight = new Map<string, Promise<CollectionGraphHandle>>();
  /**
   * Daemon mode only: ONE `DaemonGraphDbClient` (one socket) per (collection,
   * process); the client multiplexes requests by id. Closed in `closeAll` so the
   * daemon's per-connection refcount drops and its idle watcher can release the
   * RW lock.
   */
  private readonly daemonClients = new Map<string, DaemonClientEntry>();
  /** In-flight daemon-client init so concurrent first-callers share one socket. */
  private readonly daemonInflight = new Map<string, Promise<DaemonClientEntry>>();
  /**
   * Idle-eviction clock: the last time an op for the collection started or
   * completed (bd tea-rags-mcp-nlls). Only maintained when `idleEviction` is
   * wired.
   */
  private readonly lastUsedByCollection = new Map<PhysicalCollectionName, number>();
  /**
   * Ops currently running against a cached client, so eviction NEVER closes a
   * connection mid-op. `runCollectionOp` owns the refcount; `acquire` alone
   * (the daemon handshake's open-and-drop) is not an in-flight op.
   */
  private readonly opsInFlightByCollection = new Map<PhysicalCollectionName, number>();
  private idleEvictionTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: GraphDbClientPoolOptions) {
    this.dbFiles = new CodegraphDbFiles(options.rootDir);
    mkdirSync(this.codegraphDir, { recursive: true });
    // Reclaim crashed runs' spills per ENTRY, never the whole directory (bd
    // tea-rags-mcp-v6gxr): pools are built mid-flight by unpinned enrichment
    // workers, the daemon and concurrent CLI runs, and `purgeStaleSpills` keeps
    // whatever a live pid owns. Also recreates the dir for `SET temp_directory`.
    purgeStaleSpills(this.spillDir);
    if (options.idleEviction) this.scheduleIdleEviction(options.idleEviction);
  }

  private get codegraphDir(): string {
    return this.dbFiles.dir;
  }

  /**
   * Spill directory under the codegraph root, shared by every pool over the same
   * `rootDir`, across processes — hence the per-file ownership sweep at
   * construction rather than a wipe.
   */
  private get spillDir(): string {
    return this.options.resources?.tempDirectory ?? join(this.codegraphDir, ".spill");
  }

  /** Resolve the disk path for a given collection name. Exposed for tests. */
  pathFor(collectionName: PhysicalCollectionName): string {
    return this.dbFiles.pathFor(collectionName);
  }

  /**
   * Whether a graph database file exists for this collection.
   *
   * The read path needs it to tell two failures apart that `acquireReader`
   * reports identically (both throw): a collection that never had a graph —
   * indexed with codegraph off, so "no edges" is the honest answer — and one
   * whose graph is there but unreadable (lock held, daemon down, corruption),
   * where an empty edge list would be a false statement about the code.
   */
  hasDatabase(collectionName: PhysicalCollectionName): boolean {
    return this.dbFiles.has(collectionName);
  }

  /**
   * Every `<base>_v<N>.duckdb` and the unversioned `<base>.duckdb` on disk, as
   * collection names, for the orphan sweep. The unversioned name is included so
   * an alias-addressed shadow file stays reclaimable (bd tea-rags-mcp-6goqa); the
   * sweep itself skips the active alias target and live Qdrant collections.
   * Scoped to `^<base>(_v\d+)?$`; empty when the codegraph dir is missing.
   */
  listCollectionDbNames(baseCollectionName: string): PhysicalCollectionName[] {
    return this.dbFiles.listCollectionDbNames(baseCollectionName);
  }

  /**
   * Resolve the on-disk spill (NDJSON) path the streaming pass-1 uses
   * for a given collection + run. Exposed so the codegraph provider
   * does not duplicate the layout logic and tests can assert cleanup.
   */
  spillPathFor(collectionName: string, runId: string): string {
    return join(this.spillDir, `${sanitiseCollectionName(collectionName)}-${runId}.ndjson`);
  }

  /**
   * Deterministic cross-pass INPUT spill (yl9tv): the main thread appends each
   * file's `FileExtraction`, the codegraph worker drains it in `finalizeSignals`.
   * Lives in `.xpass`, which construction never sweeps — the worker builds its own
   * pool mid-run. No runId: main and worker pools share `rootDir` and must
   * resolve the same path.
   */
  inputSpillPathFor(collectionName: string): string {
    return join(this.xpassDir, `${sanitiseCollectionName(collectionName)}.ndjson`);
  }

  /** Cross-pass input-spill directory — never purged at pool construction. */
  private get xpassDir(): string {
    return join(this.codegraphDir, ".xpass");
  }

  /**
   * Return the cached handle for `collectionName` if one is already open,
   * otherwise `undefined`. Used by the GraphFacade read path so a query
   * against a collection that was never written to does NOT open a fresh
   * DB just to return an empty result.
   *
   * A cached client whose database file is gone or replaced reports as absent
   * and is NOT evicted here: replacing it needs its close awaited before the
   * path is opened again, which a synchronous call cannot do. It stays for the
   * next `acquire` to replace in that order (bd tea-rags-mcp-amh78).
   */
  peek(collectionName: PhysicalCollectionName): CollectionGraphHandle | undefined {
    const cached = this.clients.get(collectionName);
    return cached && this.holdsOpenedDatabaseFile(collectionName, cached) ? cached : undefined;
  }

  /**
   * Open (lazily) and return the handle for `collectionName`. First call
   * for a name creates the file, runs migrations, invokes the init hook
   * to hydrate the symbol table, then caches the result. Concurrent
   * first-callers share one open pass via the inflight map.
   *
   * A cached handle is returned only while its path still names the file it
   * opened. Once another process unlinked it or put a different database there,
   * the client is retired (`retireStaleClient`) and the path opened again, in
   * one in-flight pass concurrent callers share. The daemon reaches every op
   * through here, so this is the check every holder of a pool shares (bd
   * tea-rags-mcp-amh78).
   */
  async acquire(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    // The idle-eviction clock starts here even for acquires that bypass
    // `runCollectionOp` (the daemon handshake's open-and-drop), so an opened
    // collection nobody ever ops against still becomes evictable.
    if (this.options.idleEviction) this.lastUsedByCollection.set(collectionName, Date.now());
    const cached = this.clients.get(collectionName);
    if (cached && this.holdsOpenedDatabaseFile(collectionName, cached)) return cached;
    const inflight = this.inflight.get(collectionName);
    if (inflight) return inflight;

    const promise = (async (): Promise<CollectionGraphHandle> => {
      if (cached) await this.retireStaleClient(collectionName, cached);
      return this.openCollection(collectionName);
    })().finally(() => {
      this.inflight.delete(collectionName);
    });
    this.inflight.set(collectionName, promise);
    return promise;
  }

  /**
   * Whether `collectionName`'s path still names the database file `entry`
   * opened. One `statSync` per cached return — no directory scan on the hot path.
   */
  private holdsOpenedDatabaseFile(collectionName: PhysicalCollectionName, entry: PoolEntry): boolean {
    const current = statSync(this.pathFor(collectionName), { bigint: true, throwIfNoEntry: false });
    return current?.dev === entry.databaseFile.dev && current.ino === entry.databaseFile.ino;
  }

  /**
   * Retire a cached client whose database file is gone or replaced, before the
   * path is opened again (bd tea-rags-mcp-amh78). The order is the point:
   *
   * 1. Drop it from the cache synchronously, so a concurrent `acquire` shares
   *    the replacement instead of receiving it.
   * 2. Await its close. `DuckDbGraphClient#close` lets running calls finish and
   *    does not checkpoint, so it cannot delete the WAL a different database now
   *    keeps at this path. A close that fails on the unlinked file is tolerated:
   *    the file is not ours any more.
   * 3. Announce it (`onCollectionClientClosed`).
   */
  private async retireStaleClient(collectionName: PhysicalCollectionName, entry: PoolEntry): Promise<void> {
    this.clients.delete(collectionName);
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph pool: database file of ${collectionName} was removed or replaced under its ` +
          `cached client — closing it and opening ${this.pathFor(collectionName)} again\n`,
      );
    }
    try {
      await entry.graphDb.close();
    } catch (err) {
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph pool: closing the stale client of ${collectionName} failed: ${(err as Error).message}\n`,
        );
      }
    }
    this.options.onCollectionClientClosed?.(collectionName);
  }

  /**
   * Acquire a WRITE handle: through the daemon (the single RW connection across
   * processes) when `daemonSocketPath` is configured, else the in-process RW
   * handle (`acquire`).
   */
  async acquireWrite(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(collectionName);
    }
    return this.acquire(collectionName);
  }

  /**
   * Handle over the ONE cached `DaemonGraphDbClient` for the collection. Its
   * `close()` is a no-op: the pool owns the socket (`closeAll`), and a caller's
   * `finally` close must not tear it down under other in-flight callers.
   */
  private async acquireDaemonHandle(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const entry = await this.acquireDaemonClient(collectionName);
    return { graphDb: entry.wrapped, symbolTable: entry.symbolTable };
  }

  /**
   * Lazily create + init the single cached `DaemonGraphDbClient` for a
   * collection (plus its stable no-op-close wrapper). Concurrent first-callers
   * share one init pass via `daemonInflight`.
   */
  private async acquireDaemonClient(collectionName: PhysicalCollectionName): Promise<DaemonClientEntry> {
    const cached = this.daemonClients.get(collectionName);
    if (cached?.client.isConnected()) return cached;
    if (cached) {
      // A cached client routinely outlives its daemon (30s idle exit). Drop it
      // and cold-spawn: `respawn` is single-flighted and alive-checked, so it is
      // a no-op when a daemon is in fact running.
      this.daemonClients.delete(collectionName);
      this.options.daemonRestart?.respawn?.();
    }
    const inflight = this.daemonInflight.get(collectionName);
    if (inflight) return inflight;

    const socketPath = this.options.daemonSocketPath;
    /* v8 ignore next -- acquireDaemonClient is only reached when daemonSocketPath is set */
    if (!socketPath) throw new Error("acquireDaemonClient called without daemonSocketPath");

    const promise = (async (): Promise<DaemonClientEntry> => {
      // One-time legacy migration (bd tea-rags-mcp-42hno): a keyed client
      // meeting a legacy-layout daemon drains it, then clears the layout. Runs
      // inside the shared inflight pass, so concurrent first-callers race it
      // once.
      if (this.options.daemonStorageDir) await this.migrateLegacyDaemon(collectionName);
      const client = await this.connectWithBuildHandshake(socketPath, collectionName);
      const wrapped = wrapNoopClose(client);
      // Hydrate like `openCollection`, so resolution sees symbols from files not
      // re-walked this run. Non-fatal: the table starts empty and the next ingest
      // pass repopulates it.
      const symbolTable = this.options.symbolTableFactory();
      if (this.options.initHook) {
        try {
          await this.options.initHook({ collectionName, graphDb: wrapped, symbolTable });
        } catch (err) {
          process.stderr.write(
            `[tea-rags] codegraph daemon init-hook failed for ${collectionName}: ${(err as Error).message}\n`,
          );
        }
      }
      const entry: DaemonClientEntry = { client, wrapped, symbolTable };
      this.daemonClients.set(collectionName, entry);
      return entry;
    })().finally(() => {
      this.daemonInflight.delete(collectionName);
    });
    this.daemonInflight.set(collectionName, promise);
    return promise;
  }

  /**
   * Migrate a LEGACY (pre-keying, 42hno) daemon layout out of the base
   * storage dir. The five lifecycle files sitting DIRECTLY in
   * `daemonStorageDir` belong to the one shared daemon the pre-keying builds
   * all ran; a keyed client must get them out of the way so no later spawn
   * ever considers them. A live legacy daemon is drained through the EXISTING
   * flow (`drainStaleDaemon`) — the zgcmo drain-refusal guard protects any
   * in-flight writer, and a refusal propagates as the typed retryable error.
   * A dead (or unreadable) legacy pid's files are unlinked directly. Idempotent
   * and effectively free once the layout is gone: two `existsSync` calls.
   */
  private async migrateLegacyDaemon(collectionName: PhysicalCollectionName): Promise<void> {
    const dir = this.options.daemonStorageDir;
    /* v8 ignore next 2 -- the only caller checks the option first */
    if (!dir) return;
    const legacy = getLegacyDaemonPaths(dir);
    if (!existsSync(legacy.pidFile) && !existsSync(legacy.socketPath)) return;
    const pid = readDaemonPid(legacy);
    if (pid !== undefined && isDaemonPidAlive(pid)) {
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph: legacy (un-keyed) daemon layout found in ${dir} — draining it before ` +
            "connecting to this build's keyed daemon (bd tea-rags-mcp-42hno)\n",
        );
      }
      // A short connect bound: this daemon predates keying, and if it stopped
      // accepting between the pid probe and now, waiting out the full spawn
      // window buys nothing — the caller treats an unreachable socket as a
      // failure, which is the honest answer.
      const { DaemonGraphDbClient } = await import("./daemon/client.js");
      const client = new DaemonGraphDbClient(legacy.socketPath, collectionName, { connectTimeoutMs: 1_500 });
      await client.init();
      await this.drainStaleDaemon(client, legacy.socketPath);
    }
    // A drained daemon unlinks its own files in cleanup; the direct unlink
    // covers the dead-pid arm and is idempotent belt-and-braces otherwise.
    unlinkDaemonFiles(legacy);
    if (isDebug()) {
      process.stderr.write(`[tea-rags] codegraph: legacy daemon layout in ${dir} removed\n`);
    }
  }

  /**
   * Connect and run the build + capability handshake (bd tea-rags-mcp-ji56r,
   * 39xca.4). A daemon of this build serving every required op, or a
   * pre-fingerprint peer, is returned as is. A daemon of the build on disk that
   * THIS process predates is never drained (bd tea-rags-mcp-1wr7p): a
   * READ-ONLY client is returned when it serves every required op, else
   * `CodegraphClientStaleBuildError`. Otherwise a respawn-capable pool drains,
   * respawns and reconnects up to `maxRestartAttempts`, then throws
   * `CodegraphDaemonBuildSkewError` (its own build still short of an op) or
   * `CodegraphDaemonStaleBuildError`.
   *
   * The bound is small on purpose (bd tea-rags-mcp-ryoqn): each attempt drains a
   * daemon every process on the machine shares, so looping until healthy would
   * thrash them and could livelock two sessions; `CodegraphDaemonExitTimeoutError`
   * from the drain is never retried.
   */
  private async connectWithBuildHandshake(
    socketPath: string,
    collectionName: PhysicalCollectionName,
  ): Promise<DaemonGraphDbClient> {
    // Dynamic so direct/test mode never loads the node:net socket code.
    const { DaemonGraphDbClient, assessDaemonCapability, isClientStale, isDaemonRefusedWithoutRespawn } =
      await import("./daemon/client.js");
    const restart = this.options.daemonRestart;
    const localFingerprint = restart?.buildFingerprint ?? getBuildFingerprint();
    const readOnDisk = restart?.readOnDiskBuildFingerprint ?? readOnDiskBuildFingerprint;

    // Build-keyed sockets (bd tea-rags-mcp-42hno): an own-key MISS in a pool
    // that cannot spawn is the provisioning contract failing, not a slow
    // daemon. Fail fast with the retryable typed error instead of a full
    // connect-retry window — and instead of the pre-keying behavior, where a
    // hookless pool silently shared whatever build happened to be running.
    if (!restart?.respawn && !existsSync(socketPath)) {
      throw new CodegraphDaemonBuildUnavailableError({ socketPath, buildKey: getBuildKey() });
    }

    // The respawn hook doubles as crash recovery (bd tea-rags-mcp-8l8d3): a
    // daemon killed by a native abort cannot report it, so the client respawns
    // and replays in-flight requests. Pools without the hook reject them instead.
    // The on-disk reader goes along so a refused replay names the stale side
    // the way this handshake does (bd tea-rags-mcp-1wr7p).
    const clientOptions = { onConnectionLost: restart?.respawn, readOnDiskBuildFingerprint: readOnDisk };
    const first = new DaemonGraphDbClient(socketPath, collectionName, clientOptions);
    await first.init();
    const verdict = assessDaemonCapability(await first.handshake(localFingerprint), localFingerprint);
    // Same build serving every required op, or a legacy pre-fingerprint peer.
    if (!needsDaemonReplacement(verdict)) return first;
    // Asked BEFORE the respawn question: a pool without the hook must name the
    // stale side correctly too when it refuses.
    const onDisk = readOnDisk();
    if (onDisk !== undefined && isClientStale(verdict, onDisk)) {
      return this.settleWithStaleClient(first, verdict, { socketPath, clientFingerprint: localFingerprint, onDisk });
    }

    // No respawn hook (worker-thread pools rebuilt from serializable config):
    // never drain — the daemon is shared machine-wide and this pool could not
    // bring one back. Proceed only against a daemon advertising every required
    // op; refuse one lacking an op, or too old to say (bd tea-rags-mcp-39xca.4).
    const respawn = restart?.respawn;
    if (!respawn) {
      if (isDaemonRefusedWithoutRespawn(verdict)) {
        await first.close();
        throw new CodegraphDaemonBuildSkewError({
          socketPath,
          missingOps: verdict.missingRequiredOps,
          clientFingerprint: localFingerprint,
          daemonFingerprint: verdict.daemonFingerprint,
        });
      }
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, localFingerprint)} — no respawn hook wired, ` +
            `proceeding with the running daemon (it advertises every required op)\n`,
        );
      }
      return first;
    }

    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, localFingerprint)} — draining stale daemon ` +
          `and respawning from this build\n`,
      );
    }
    const maxAttempts = Math.max(1, restart?.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS);
    const baseDelayMs = restart?.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    // Post-restart observations only — the pre-restart fingerprint is a
    // mismatch by definition, so including it would make every wedged daemon
    // look like a race.
    const observedDaemonFingerprints: string[] = [];
    let stale = first;
    let lastVerdict = verdict;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Linear backoff with full jitter, so two sessions retrying in lockstep
      // decorrelate instead of trading the daemon back and forth.
      if (attempt > 1) {
        const waitMs = baseDelayMs * (attempt - 1) + Math.random() * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      // Re-drain each round: our respawn no-ops while another session's daemon
      // is alive, so without this the next attempt would observe the same
      // foreign build it just saw.
      await this.drainStaleDaemon(stale, socketPath);
      respawn();

      // Reconnect (init retries the connect while the fresh daemon boots) and
      // re-verify build and capabilities.
      const next = new DaemonGraphDbClient(socketPath, collectionName, clientOptions);
      await next.init();
      const nextVerdict = assessDaemonCapability(await next.handshake(localFingerprint), localFingerprint);
      if (!needsDaemonReplacement(nextVerdict)) return next;
      // The respawn launched the on-disk build and this process predates it:
      // from here the daemon is the up-to-date peer, and another drain would
      // take it down for every session already on it (bd tea-rags-mcp-1wr7p).
      const nextOnDisk = readOnDisk();
      if (nextOnDisk !== undefined && isClientStale(nextVerdict, nextOnDisk)) {
        return this.settleWithStaleClient(next, nextVerdict, {
          socketPath,
          clientFingerprint: localFingerprint,
          onDisk: nextOnDisk,
        });
      }
      if (nextVerdict.daemonFingerprint !== undefined) observedDaemonFingerprints.push(nextVerdict.daemonFingerprint);
      lastVerdict = nextVerdict;
      stale = next;
    }

    await stale.close();
    if (!lastVerdict.buildMismatch) {
      // Our own build came back every time, still without a required op — the
      // respawn hook launches a daemon whose op table is short, not a stale one.
      throw new CodegraphDaemonBuildSkewError({
        socketPath,
        missingOps: lastVerdict.missingRequiredOps,
        clientFingerprint: localFingerprint,
        daemonFingerprint: lastVerdict.daemonFingerprint,
      });
    }
    throw new CodegraphDaemonStaleBuildError(
      socketPath,
      localFingerprint,
      /* v8 ignore next -- buildMismatch implies the daemon reported a fingerprint */
      lastVerdict.daemonFingerprint ?? "unknown",
      observedDaemonFingerprints,
    );
  }

  /**
   * Settle a handshake whose stale side is THIS process (bd tea-rags-mcp-1wr7p):
   * never drain, never respawn. Proceed against the daemon when it serves every
   * op this client requires — the same bar a pool without a respawn hook
   * applies — else close and fail fast with `CodegraphClientStaleBuildError`.
   * Reloading this process is the only remedy; tea-rags does not restart it.
   * `builds.onDisk` is what `isClientStale` matched the daemon's fingerprint
   * against, so it names the daemon's build too.
   *
   * Proceeding is READ-ONLY (`DaemonGraphDbClient#restrictToReads`): the
   * capability check matches op names, so a write whose payload shape moved
   * under an unchanged name would land unnoticed. The graph reads the query
   * tools issue keep working; every write throws the same typed error.
   */
  private async settleWithStaleClient(
    client: DaemonGraphDbClient,
    verdict: DaemonCapabilityVerdict,
    builds: { socketPath: string; clientFingerprint: string; onDisk: string },
  ): Promise<DaemonGraphDbClient> {
    const { isDaemonRefusedWithoutRespawn } = await import("./daemon/client.js");
    if (isDaemonRefusedWithoutRespawn(verdict)) {
      await client.close();
      throw new CodegraphClientStaleBuildError({
        socketPath: builds.socketPath,
        clientFingerprint: builds.clientFingerprint,
        daemonFingerprint: builds.onDisk,
        missingOps: verdict.missingRequiredOps,
      });
    }
    client.restrictToReads({ clientFingerprint: builds.clientFingerprint, daemonFingerprint: builds.onDisk });
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon ${describeDaemonSkew(verdict, builds.clientFingerprint)} — this process predates ` +
          "the build on disk the daemon runs; proceeding read-only without a restart (it advertises every required " +
          "op). Reconnect the MCP server to load the current build\n",
      );
    }
    return client;
  }

  /**
   * Gracefully retire a stale daemon: request the drain (acked, then the
   * daemon reuses its idle-watcher teardown), close our socket so the daemon's
   * `server.close` is not held open by us, and poll the lifecycle files until
   * the old process is gone. Times out with a typed error — never cold-spawns
   * on top of a daemon that still holds the socket + RW lock.
   */
  private async drainStaleDaemon(client: DaemonGraphDbClient, socketPath: string): Promise<void> {
    // The lifecycle files live in the directory owning the socket — the key
    // dir for a keyed daemon, the base dir for the legacy layout the one-time
    // migration drains. NEVER re-keyed: `getDaemonPaths` would nest this
    // build's key UNDER it (bd tea-rags-mcp-42hno).
    const paths = daemonPathsForKeyDir(dirname(socketPath));
    const stalePid = readDaemonPid(paths);
    let refusal: Error | undefined;
    try {
      await client.requestShutdown();
    } catch (err) {
      // The daemon refused because another connection's writes are in flight
      // (bd tea-rags-mcp-zgcmo): settle the drain with the typed refusal
      // instead of waiting out an exit that will never start — the daemon
      // stays up on purpose. Any OTHER shutdown failure (an old daemon that
      // answers the op as unknown, a lost socket) keeps the historical
      // swallow-and-poll path, whose timeout names the wedge.
      if (isDaemonDrainRefusal(err)) refusal = err;
    }
    await client.close();
    if (refusal) {
      throw new CodegraphDaemonDrainRefusedError({ socketPath }, refusal);
    }
    const restart = this.options.daemonRestart;
    const exited = await waitForDaemonExit(paths, stalePid, {
      timeoutMs: restart?.exitTimeoutMs,
      pollIntervalMs: restart?.pollIntervalMs,
    });
    if (!exited) {
      throw new CodegraphDaemonExitTimeoutError(socketPath, restart?.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
    }
  }

  /**
   * Acquire a READ-ONLY handle: the live `<collection>.duckdb` attached
   * in-process with `access_mode=READ_ONLY` (unlimited concurrent cross-process
   * readers). Not cached — callers MUST `close()` it.
   *
   * An attach the driver refuses (lock held, unreadable file) rejects with
   * `DuckDbOpenFailedError`, like the RW path — optional read consumers
   * degrade on that class, not on driver message text (bd tea-rags-mcp-a43tr).
   */
  async acquireRead(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const dbPath = this.pathFor(collectionName);
    const graphDb = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
    try {
      await graphDb.init();
    } catch (err) {
      await graphDb.close().catch(() => undefined);
      throw new DuckDbOpenFailedError(dbPath, err instanceof Error ? err : undefined);
    }
    return { graphDb, symbolTable: this.options.symbolTableFactory() };
  }

  /**
   * Mode-aware READ handle for the GraphFacade. Daemon mode proxies reads through
   * the daemon's own RW connection — a cross-process READ_ONLY attach throws
   * "Conflicting lock is held" while the daemon holds RW. Direct/test mode
   * attaches READ_ONLY in-process (`acquireRead`). Calling `close()` is safe
   * either way (a no-op in daemon mode).
   */
  async acquireReader(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(collectionName);
    }
    return this.acquireRead(collectionName);
  }

  private async openCollection(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    // Bounded open retry (bd tea-rags-mcp-42hno): two build-keyed daemons
    // serve the same on-disk collections, so a loser's first open loses the
    // DuckDB RW lock to the winner's still-cached client. The wait is bounded
    // BY DESIGN — nlls evicts the idle holder — so retrying until then turns
    // a shared-collection collision from a failed op into a delay.
    const retry = this.options.openRetry;
    const deadline = retry ? Date.now() + retry.maxMs : 0;
    for (;;) {
      try {
        return await this.openCollectionOnce(collectionName);
      } catch (err) {
        const intervalMs = retry?.intervalMs ?? DEFAULT_OPEN_RETRY_INTERVAL_MS;
        if (!retry || !(err instanceof DuckDbOpenFailedError) || Date.now() + intervalMs > deadline) {
          throw err;
        }
        if (isDebug()) {
          process.stderr.write(
            `[tea-rags] codegraph pool: open of ${this.pathFor(collectionName)} failed (lock held) — ` +
              `retrying until ${new Date(deadline).toISOString()} (bd tea-rags-mcp-42hno)\n`,
          );
        }
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
    }
  }

  /** ONE open attempt for `openCollection` — no retry, no cache check. */
  private async openCollectionOnce(collectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    // The one read-write open in the codebase — the daemon's pool reaches it too —
    // so this is where a shadow `<alias>.duckdb` would be created. Refused there.
    const dbPath = this.dbFiles.writablePathFor(collectionName);
    // A WAL without its database is what a client writing into an unlinked file
    // leaves behind; it must never reach the driver as this file's log (amh78).
    await this.dbFiles.discardOrphanedWal(collectionName);
    const graphDb = new DuckDbGraphClient({
      path: dbPath,
      resources: {
        memoryLimit: this.options.resources?.memoryLimit,
        threads: this.options.resources?.threads,
        tempDirectory: this.spillDir,
        preserveInsertionOrder: this.options.resources?.preserveInsertionOrder,
      },
    });
    let databaseFile: OpenedDatabaseFile;
    try {
      await graphDb.init();
      // The file this open created or found — what every cached return checks.
      const opened = statSync(dbPath, { bigint: true });
      databaseFile = { dev: opened.dev, ino: opened.ino };
      // The DDL steps live in the maintenance domain, which adapters may not
      // import — the composition root injects the applier (required option, so
      // a missed call site is a type error rather than a schema-less DB).
      await this.options.applyMigrations(graphDb);
    } catch (err) {
      await graphDb.close().catch(() => undefined);
      throw new DuckDbOpenFailedError(dbPath, err instanceof Error ? err : undefined);
    }

    const symbolTable = this.options.symbolTableFactory();
    if (this.options.initHook) {
      try {
        await this.options.initHook({ collectionName, graphDb, symbolTable });
      } catch (err) {
        // Non-fatal: the DB is open, the symbol table just starts empty and the
        // next ingest pass repopulates affected files.
        process.stderr.write(
          `[tea-rags] codegraph init-hook failed for ${collectionName}: ${(err as Error).message}\n`,
        );
      }
    }

    const entry: PoolEntry = { graphDb, symbolTable, databaseFile };
    this.clients.set(collectionName, entry);
    return entry;
  }

  /**
   * Run ONE collection op under the pool's idle-eviction tracking (bd
   * tea-rags-mcp-nlls): the in-flight refcount is raised for the duration — an
   * eviction pass inside the op is short-circuited — and the idle clock is
   * stamped at start AND completion, so a collection becomes evictable a full
   * `idleMs` after its last op finished, not after it started. The daemon
   * server routes every per-collection op through here; eviction never fires
   * on a client whose connection is executing.
   */
  async runCollectionOp<T>(
    collectionName: PhysicalCollectionName,
    op: (handle: CollectionGraphHandle) => Promise<T>,
  ): Promise<T> {
    if (this.options.idleEviction) {
      this.lastUsedByCollection.set(collectionName, Date.now());
      this.opsInFlightByCollection.set(collectionName, (this.opsInFlightByCollection.get(collectionName) ?? 0) + 1);
    }
    try {
      return await op(await this.acquire(collectionName));
    } finally {
      if (this.options.idleEviction) {
        this.lastUsedByCollection.set(collectionName, Date.now());
        const remaining = (this.opsInFlightByCollection.get(collectionName) ?? 1) - 1;
        if (remaining <= 0) this.opsInFlightByCollection.delete(collectionName);
        else this.opsInFlightByCollection.set(collectionName, remaining);
      }
    }
  }

  /** Start the eviction poller (`unref()`'d — never keeps the process alive). */
  private scheduleIdleEviction(eviction: GraphDbClientPoolIdleEviction): void {
    this.idleEvictionTimer = setInterval(() => {
      void this.evictIdleCollectionClients().catch(() => undefined);
    }, eviction.pollMs ?? 5_000);
    this.idleEvictionTimer.unref();
  }

  /**
   * Close and drop every cached client whose collection has been idle past
   * `idleMs` with no op in flight. Eviction goes through `release`, so the
   * `onCollectionClientClosed` parity hook fires (the daemon's memory governor
   * takes the entry with it) and the next acquire lazily re-opens.
   */
  private async evictIdleCollectionClients(): Promise<void> {
    const eviction = this.options.idleEviction;
    if (!eviction) return;
    const now = Date.now();
    for (const collectionName of [...this.clients.keys()]) {
      if ((this.opsInFlightByCollection.get(collectionName) ?? 0) > 0) continue;
      const lastUsed = this.lastUsedByCollection.get(collectionName);
      if (lastUsed === undefined || now - lastUsed < eviction.idleMs) continue;
      const idleSeconds = Math.round((now - lastUsed) / 1000);
      const evicted = await this.release(collectionName);
      if (evicted) {
        process.stderr.write(
          `[tea-rags] codegraph pool: evicted idle pool entry for ${collectionName} after ${idleSeconds}s idle\n`,
        );
      }
    }
  }

  /**
   * Drop the cached client for a collection (close + forget), e.g. to release the
   * file lock between test scenarios. Returns true when an entry was evicted.
   */
  async release(collectionName: PhysicalCollectionName): Promise<boolean> {
    const entry = this.clients.get(collectionName);
    if (!entry) return false;
    this.clients.delete(collectionName);
    this.lastUsedByCollection.delete(collectionName);
    await entry.graphDb.close().catch(() => undefined);
    this.options.onCollectionClientClosed?.(collectionName);
    return true;
  }

  /**
   * Copy sourceCollection's DuckDB file to targetCollection, WAL sidecar
   * included; no-op without a source file.
   *
   * The `.wal` holds everything since the last checkpoint, so a clone without it
   * is silently rolled back — `removeCollection` treats the pair as one artifact
   * too. A target WAL with no source counterpart is REMOVED: collection names get
   * reused, and replaying a previous tenant's log over the copy is worse. `release`
   * does not checkpoint: it closes this pool's cached client through
   * `DuckDbGraphSession#close`, which leaves the WAL in place, and a database the
   * daemon holds stays open in the daemon. Either way the source WAL can carry
   * writes the database file lacks, which is why the sidecar is copied rather
   * than assumed empty.
   */
  async cloneDatabase(
    sourceCollection: PhysicalCollectionName,
    targetCollection: PhysicalCollectionName,
  ): Promise<void> {
    await this.release(sourceCollection);
    await this.dbFiles.cloneDatabase(sourceCollection, targetCollection);
  }

  /**
   * Drop the cached client AND delete the on-disk DuckDB file plus WAL, so the
   * codegraph DB does not outlive the Qdrant collection it shadows (clear /
   * delete / force-reindex paths).
   *
   * Contract:
   * - Close failure throws `DuckDbCloseFailedError` and the file is NOT unlinked:
   *   unlinking a file the driver still holds is undefined on some platforms.
   * - Unlink errors are swallowed (ENOENT makes it idempotent; anything else
   *   leaves a stale file a later `acquire` overwrites, rather than a
   *   half-mutated pool).
   *
   * Returns true when a cached entry was evicted; disk cleanup runs regardless.
   */
  async removeCollection(collectionName: PhysicalCollectionName): Promise<boolean> {
    const dbPath = this.pathFor(collectionName);
    const entry = this.clients.get(collectionName);
    let evicted = false;
    if (entry) {
      this.clients.delete(collectionName);
      try {
        await entry.graphDb.close();
      } catch (err) {
        throw new DuckDbCloseFailedError(dbPath, err instanceof Error ? err : undefined);
      } finally {
        this.options.onCollectionClientClosed?.(collectionName);
      }
      evicted = true;
    }
    await this.dbFiles.removeFiles(collectionName);
    return evicted;
  }

  /**
   * Close every cached client — in-process RW clients AND daemon-mode sockets.
   * Idempotent; used at shutdown. Closing the sockets is what lets the daemon's
   * refcount reach 0 and its idle watcher release the RW lock.
   */
  async closeAll(): Promise<void> {
    const all = [...this.clients.entries()];
    this.clients.clear();
    this.lastUsedByCollection.clear();
    this.opsInFlightByCollection.clear();
    const daemons = [...this.daemonClients.values()];
    this.daemonClients.clear();
    await Promise.all([
      ...all.map(async ([collectionName, e]) => {
        await e.graphDb.close().catch(() => undefined);
        this.options.onCollectionClientClosed?.(collectionName);
      }),
      ...daemons.map(async (e) => e.client.close().catch(() => undefined)),
    ]);
  }
}

/**
 * Wrap a cached `DaemonGraphDbClient` so the handle handed to a caller has a
 * NO-OP `close()`. Every other method/property forwards to the real client.
 * The pool owns the single socket per collection and closes it in `closeAll`;
 * a per-call `close()` (e.g. `GraphFacade.withReadHandle`'s `finally`) must NOT
 * tear down the shared socket out from under other in-flight callers.
 */
function wrapNoopClose(client: DaemonGraphDbClient): GraphDbClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async (): Promise<void> => undefined;
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Per-collection bundle handed to the codegraph trajectory. The
 * trajectory owns the resolvers map (process-scoped, not per-collection)
 * and the pool (which yields per-collection graphDb + symbolTable).
 */
export interface CodegraphPoolDeps {
  pool: GraphDbClientPool;
  resolvers: Map<string, CallResolver>;
}
