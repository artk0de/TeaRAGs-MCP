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
 * file it holds open — see `acquire` (bd tea-rags-mcp-amh78). A storage
 * compaction swapping that file under the client (bd tea-rags-mcp-dvzdm) is not
 * such a replacement: the client reports the file it holds NOW.
 *
 * Every in-process replacer of a database path — `removeCollection`,
 * `cloneDatabase` — holds that path's LEASE while it works: it retires the
 * cached client, waits for every op pinned to it (`runCollectionOp`) to finish,
 * closes it, and only then touches the file; ops issued meanwhile wait for the
 * lease and run on the successor (bd tea-rags-mcp-r4veq). In daemon mode the
 * clients live in the daemon, so both replacers send the replacement there
 * (`DaemonDatabaseFileReplacer`) and the daemon's own pool takes the lease;
 * they act on the files themselves only when no daemon of this build is up, or
 * it cannot take the op. A replacement nobody routes — another build's daemon,
 * a process outside tea-rags — is still caught only by the dev/ino check on the
 * next acquire.
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
import type { DaemonDatabaseFileReplacer, DaemonDatabaseReplacement } from "./daemon/database-file-replacer.js";
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
  CodegraphDaemonUnreachableError,
  CodegraphDatabaseMissingError,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
  isDaemonDrainRefusal,
} from "./errors.js";
import { purgeStaleSpills } from "./spill-files.js";
import type { CodegraphCompactionPolicy } from "./storage-compaction.js";

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
   * When a client this pool opens compacts its database file (bd
   * tea-rags-mcp-dvzdm). Absent everywhere in production, so the default
   * policy applies; tests lower the floor so a small fixture qualifies.
   */
  compactionPolicy?: CodegraphCompactionPolicy;
  /**
   * Called after the pool closes — or tries to close — the cached read-write
   * client it held for a collection: a stale client being replaced, `release`,
   * `removeCollection`, `closeAll`. Whoever keeps per-collection state keyed by
   * that handle drops it here; the daemon wires its `DaemonMemoryGovernor`
   * (bd tea-rags-mcp-amh78).
   */
  onCollectionClientClosed?: (physicalCollectionName: PhysicalCollectionName) => void;
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
 * A cached client. The file it holds open is asked of the client itself
 * (`DuckDbGraphClient#openedDatabaseFile`), not recorded here at open time: a
 * storage compaction swaps the file under the client (bd tea-rags-mcp-dvzdm),
 * and an identity snapshotted by the pool would read that as the file being
 * replaced behind the client's back (bd tea-rags-mcp-amh78).
 */
interface PoolEntry {
  graphDb: DuckDbGraphClient;
  symbolTable: GlobalSymbolTable;
  /** Ops running on this client through `runCollectionOp` — what a path lease drains. */
  pinnedOps: number;
  /** Resolved once `pinnedOps` returns to zero. */
  drainWaiters: (() => void)[];
  /** Out of the cache: an op that raced the retirement must re-acquire, never pin it. */
  retired: boolean;
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
  private readonly inflight = new Map<string, Promise<PoolEntry>>();
  /**
   * Path leases held by in-process replacers (bd tea-rags-mcp-r4veq), one
   * settle-on-release promise per collection. `acquire` waits out a lease
   * before it hands out or opens a client; no lease costs one `Map.get`.
   */
  private readonly pathLeases = new Map<PhysicalCollectionName, Promise<void>>();
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
  pathFor(physicalCollectionName: PhysicalCollectionName): string {
    return this.dbFiles.pathFor(physicalCollectionName);
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
  hasDatabase(physicalCollectionName: PhysicalCollectionName): boolean {
    return this.dbFiles.has(physicalCollectionName);
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
   * Every generation with a database OR a cross-pass input spill on disk — what
   * a generation sweep enumerates (`CodegraphDbFiles#listCollectionGenerationNames`).
   */
  listCollectionGenerationNames(baseCollectionName: string): PhysicalCollectionName[] {
    return this.dbFiles.listCollectionGenerationNames(baseCollectionName);
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
   * resolve the same path. Its layout, and its removal with the generation
   * (`removeCollection`), belong to `CodegraphDbFiles`.
   */
  inputSpillPathFor(collectionName: string): string {
    return this.dbFiles.inputSpillPathFor(collectionName);
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
  peek(physicalCollectionName: PhysicalCollectionName): CollectionGraphHandle | undefined {
    const cached = this.clients.get(physicalCollectionName);
    return cached && this.holdsOpenedDatabaseFile(physicalCollectionName, cached) ? cached : undefined;
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
   *
   * While an in-process replacer holds the path's lease, the acquire waits for
   * it and then resolves against whatever the replacer left (bd
   * tea-rags-mcp-r4veq).
   */
  async acquire(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    return this.acquireEntry(physicalCollectionName);
  }

  private async acquireEntry(physicalCollectionName: PhysicalCollectionName): Promise<PoolEntry> {
    // Looped: a lease that settles may be followed by the next replacer's.
    for (
      let lease = this.pathLeases.get(physicalCollectionName);
      lease;
      lease = this.pathLeases.get(physicalCollectionName)
    ) {
      await lease;
    }
    // The idle-eviction clock starts here even for acquires that bypass
    // `runCollectionOp` (the daemon handshake's open-and-drop), so an opened
    // collection nobody ever ops against still becomes evictable.
    if (this.options.idleEviction) this.lastUsedByCollection.set(physicalCollectionName, Date.now());
    const cached = this.clients.get(physicalCollectionName);
    if (cached && this.holdsOpenedDatabaseFile(physicalCollectionName, cached)) return cached;
    const inflight = this.inflight.get(physicalCollectionName);
    if (inflight) return inflight;

    const promise = (async (): Promise<PoolEntry> => {
      if (cached) await this.retireStaleClient(physicalCollectionName, cached);
      return this.openCollection(physicalCollectionName);
    })().finally(() => {
      this.inflight.delete(physicalCollectionName);
    });
    this.inflight.set(physicalCollectionName, promise);
    return promise;
  }

  /**
   * Whether `collectionName`'s path still names the database file `entry`
   * opened. One `statSync` per cached return — no directory scan on the hot path.
   */
  private holdsOpenedDatabaseFile(physicalCollectionName: PhysicalCollectionName, entry: PoolEntry): boolean {
    const opened = entry.graphDb.openedDatabaseFile();
    if (!opened) return false;
    const current = statSync(this.pathFor(physicalCollectionName), { bigint: true, throwIfNoEntry: false });
    return current?.dev === opened.dev && current.ino === opened.ino;
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
   *
   * Unlike a lease holder it does NOT drain pinned ops first: the file was
   * replaced by someone outside the lease, so the successor is already at the
   * path, and letting an op keep writing would put its rows into the
   * successor's WAL. Closing now fails such an op cleanly instead.
   */
  private async retireStaleClient(physicalCollectionName: PhysicalCollectionName, entry: PoolEntry): Promise<void> {
    entry.retired = true;
    this.clients.delete(physicalCollectionName);
    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph pool: database file of ${physicalCollectionName} was removed or replaced under its ` +
          `cached client — closing it and opening ${this.pathFor(physicalCollectionName)} again\n`,
      );
    }
    try {
      await entry.graphDb.close();
    } catch (err) {
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph pool: closing the stale client of ${physicalCollectionName} failed: ${(err as Error).message}\n`,
        );
      }
    }
    this.options.onCollectionClientClosed?.(physicalCollectionName);
  }

  /**
   * Acquire a WRITE handle: through the daemon (the single RW connection across
   * processes) when `daemonSocketPath` is configured, else the in-process RW
   * handle (`acquire`).
   */
  async acquireWrite(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(physicalCollectionName);
    }
    return this.acquire(physicalCollectionName);
  }

  /**
   * Handle over the ONE cached `DaemonGraphDbClient` for the collection. Its
   * `close()` is a no-op: the pool owns the socket (`closeAll`), and a caller's
   * `finally` close must not tear it down under other in-flight callers.
   */
  private async acquireDaemonHandle(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const entry = await this.acquireDaemonClient(physicalCollectionName);
    return { graphDb: entry.wrapped, symbolTable: entry.symbolTable };
  }

  /**
   * Lazily create + init the single cached `DaemonGraphDbClient` for a
   * collection (plus its stable no-op-close wrapper). Concurrent first-callers
   * share one init pass via `daemonInflight`.
   */
  private async acquireDaemonClient(physicalCollectionName: PhysicalCollectionName): Promise<DaemonClientEntry> {
    const cached = this.daemonClients.get(physicalCollectionName);
    if (cached?.client.isConnected()) return cached;
    if (cached) {
      // A cached client routinely outlives its daemon (30s idle exit). Drop it
      // and cold-spawn: `respawn` is single-flighted and alive-checked, so it is
      // a no-op when a daemon is in fact running.
      this.daemonClients.delete(physicalCollectionName);
      this.options.daemonRestart?.respawn?.();
    }
    const inflight = this.daemonInflight.get(physicalCollectionName);
    if (inflight) return inflight;

    const socketPath = this.options.daemonSocketPath;
    /* v8 ignore next -- acquireDaemonClient is only reached when daemonSocketPath is set */
    if (!socketPath) throw new Error("acquireDaemonClient called without daemonSocketPath");

    const promise = (async (): Promise<DaemonClientEntry> => {
      // One-time legacy migration (bd tea-rags-mcp-42hno): a keyed client
      // meeting a legacy-layout daemon drains it, then clears the layout. Runs
      // inside the shared inflight pass, so concurrent first-callers race it
      // once.
      if (this.options.daemonStorageDir) await this.migrateLegacyDaemon(physicalCollectionName);
      const client = await this.connectWithBuildHandshake(socketPath, physicalCollectionName);
      const wrapped = wrapNoopClose(client);
      // Hydrate like `openCollection`, so resolution sees symbols from files not
      // re-walked this run. Non-fatal: the table starts empty and the next ingest
      // pass repopulates it.
      const symbolTable = this.options.symbolTableFactory();
      if (this.options.initHook) {
        try {
          await this.options.initHook({ collectionName: physicalCollectionName, graphDb: wrapped, symbolTable });
        } catch (err) {
          process.stderr.write(
            `[tea-rags] codegraph daemon init-hook failed for ${physicalCollectionName}: ${(err as Error).message}\n`,
          );
        }
      }
      const entry: DaemonClientEntry = { client, wrapped, symbolTable };
      this.daemonClients.set(physicalCollectionName, entry);
      return entry;
    })().finally(() => {
      this.daemonInflight.delete(physicalCollectionName);
    });
    this.daemonInflight.set(physicalCollectionName, promise);
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
  private async migrateLegacyDaemon(physicalCollectionName: PhysicalCollectionName): Promise<void> {
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
      const client = new DaemonGraphDbClient(legacy.socketPath, physicalCollectionName, { connectTimeoutMs: 1_500 });
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
    physicalCollectionName: PhysicalCollectionName,
  ): Promise<DaemonGraphDbClient> {
    // Dynamic so direct/test mode never loads the node:net socket code.
    const { DaemonGraphDbClient, assessDaemonCapability, isClientStale, isDaemonRefusedWithoutRespawn } =
      await import("./daemon/client.js");
    const restart = this.options.daemonRestart;
    const localFingerprint = restart?.buildFingerprint ?? getBuildFingerprint();
    const readOnDisk = restart?.readOnDiskBuildFingerprint ?? readOnDiskBuildFingerprint;

    // The respawn hook doubles as crash recovery (bd tea-rags-mcp-8l8d3): a
    // daemon killed by a native abort cannot report it, so the client respawns
    // and replays in-flight requests. Pools without the hook reject them instead.
    // The on-disk reader goes along so a refused replay names the stale side
    // the way this handshake does (bd tea-rags-mcp-1wr7p).
    const clientOptions = { onConnectionLost: restart?.respawn, readOnDiskBuildFingerprint: readOnDisk };
    const first = new DaemonGraphDbClient(socketPath, physicalCollectionName, clientOptions);
    try {
      await first.init();
    } catch (err) {
      // Build-keyed sockets (bd tea-rags-mcp-42hno): the connect window still
      // absorbs the spawn→listen race (a worker's first connect races the
      // fire-and-forget `beginRun` spawn), so only a socket that NEVER
      // appeared within it is an OWN-KEY MISS. In a pool that cannot spawn
      // that is the provisioning contract failing, not a wedged daemon —
      // surface the retryable typed error instead of the pre-keying behavior,
      // where a hookless pool silently shared whatever build was running.
      if (!restart?.respawn && !existsSync(socketPath) && err instanceof CodegraphDaemonUnreachableError) {
        throw new CodegraphDaemonBuildUnavailableError({ socketPath, buildKey: getBuildKey() }, err);
      }
      throw err;
    }
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
      const next = new DaemonGraphDbClient(socketPath, physicalCollectionName, clientOptions);
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
  async acquireRead(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    const dbPath = this.pathFor(physicalCollectionName);
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
   *
   * A reader never CREATES a database (bd tea-rags-mcp-kn2cb): the daemon opens
   * collections read-write, so proxying a read of a collection with no file
   * materialized an empty one, and from then on the collection claimed a graph
   * it never had — `hasDatabase` turned true and the empty-vs-error contract
   * of every graph read flipped for it.
   *
   * @throws CodegraphDatabaseMissingError when the collection has no database.
   */
  async acquireReader(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    if (!this.hasDatabase(physicalCollectionName)) {
      throw new CodegraphDatabaseMissingError(this.pathFor(physicalCollectionName));
    }
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(physicalCollectionName);
    }
    return this.acquireRead(physicalCollectionName);
  }

  private async openCollection(physicalCollectionName: PhysicalCollectionName): Promise<PoolEntry> {
    // Bounded open retry (bd tea-rags-mcp-42hno): two build-keyed daemons
    // serve the same on-disk collections, so a loser's first open loses the
    // DuckDB RW lock to the winner's still-cached client. The wait is bounded
    // BY DESIGN — nlls evicts the idle holder — so retrying until then turns
    // a shared-collection collision from a failed op into a delay.
    const retry = this.options.openRetry;
    const deadline = retry ? Date.now() + retry.maxMs : 0;
    for (;;) {
      try {
        return await this.openCollectionOnce(physicalCollectionName);
      } catch (err) {
        const intervalMs = retry?.intervalMs ?? DEFAULT_OPEN_RETRY_INTERVAL_MS;
        if (!retry || !(err instanceof DuckDbOpenFailedError) || Date.now() + intervalMs > deadline) {
          throw err;
        }
        if (isDebug()) {
          process.stderr.write(
            `[tea-rags] codegraph pool: open of ${this.pathFor(physicalCollectionName)} failed (lock held) — ` +
              `retrying until ${new Date(deadline).toISOString()} (bd tea-rags-mcp-42hno)\n`,
          );
        }
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
    }
  }

  /** ONE open attempt for `openCollection` — no retry, no cache check. */
  private async openCollectionOnce(physicalCollectionName: PhysicalCollectionName): Promise<PoolEntry> {
    // The one read-write open in the codebase — the daemon's pool reaches it too —
    // so this is where a shadow `<alias>.duckdb` would be created. Refused there.
    const dbPath = this.dbFiles.writablePathFor(physicalCollectionName);
    // A WAL without its database is what a client writing into an unlinked file
    // leaves behind; it must never reach the driver as this file's log (amh78).
    await this.dbFiles.discardOrphanedWal(physicalCollectionName);
    const graphDb = new DuckDbGraphClient({
      path: dbPath,
      resources: {
        memoryLimit: this.options.resources?.memoryLimit,
        threads: this.options.resources?.threads,
        tempDirectory: this.spillDir,
        preserveInsertionOrder: this.options.resources?.preserveInsertionOrder,
      },
      compactionPolicy: this.options.compactionPolicy,
    });
    try {
      // Records the file this open created or found — what every cached return checks.
      await graphDb.init();
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
        await this.options.initHook({ collectionName: physicalCollectionName, graphDb, symbolTable });
      } catch (err) {
        // Non-fatal: the DB is open, the symbol table just starts empty and the
        // next ingest pass repopulates affected files.
        process.stderr.write(
          `[tea-rags] codegraph init-hook failed for ${physicalCollectionName}: ${(err as Error).message}\n`,
        );
      }
    }

    const entry: PoolEntry = { graphDb, symbolTable, pinnedOps: 0, drainWaiters: [], retired: false };
    this.clients.set(physicalCollectionName, entry);
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
   *
   * The op is also PINNED to the client it runs on for its whole duration, so a
   * path lease holder waits for it before the client closes and the file is
   * touched (bd tea-rags-mcp-r4veq).
   */
  async runCollectionOp<T>(
    physicalCollectionName: PhysicalCollectionName,
    op: (handle: CollectionGraphHandle) => Promise<T>,
  ): Promise<T> {
    if (this.options.idleEviction) {
      this.lastUsedByCollection.set(physicalCollectionName, Date.now());
      this.opsInFlightByCollection.set(
        physicalCollectionName,
        (this.opsInFlightByCollection.get(physicalCollectionName) ?? 0) + 1,
      );
    }
    try {
      const entry = await this.pinClient(physicalCollectionName);
      try {
        return await op(entry);
      } finally {
        unpinClient(entry);
      }
    } finally {
      if (this.options.idleEviction) {
        this.lastUsedByCollection.set(physicalCollectionName, Date.now());
        const remaining = (this.opsInFlightByCollection.get(physicalCollectionName) ?? 1) - 1;
        if (remaining <= 0) this.opsInFlightByCollection.delete(physicalCollectionName);
        else this.opsInFlightByCollection.set(physicalCollectionName, remaining);
      }
    }
  }

  /**
   * Acquire the collection's client and pin one op to it. The pin is taken in
   * the same synchronous step that checks the client is still current: a lease
   * taken, or a retirement begun, while the acquire was pending sends the op
   * round again, so it can never pin a client a replacer already drained.
   */
  private async pinClient(collectionName: PhysicalCollectionName): Promise<PoolEntry> {
    for (;;) {
      const entry = await this.acquireEntry(collectionName);
      if (!entry.retired && !this.pathLeases.has(collectionName)) {
        entry.pinnedOps += 1;
        return entry;
      }
    }
  }

  /**
   * Hold the path leases of `collectionNames` while `replace` runs (bd
   * tea-rags-mcp-r4veq). Leases are taken in sorted order, so two replacers
   * sharing paths (a clone A→B racing one B→A) cannot deadlock, and always
   * released, even when `replace` throws.
   */
  private async withPathLeases<T>(collectionNames: PhysicalCollectionName[], replace: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      for (const collectionName of [...new Set(collectionNames)].sort()) {
        releases.push(await this.takePathLease(collectionName));
      }
      return await replace();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** Wait for the current holder of the path's lease, if any, then take it. */
  private async takePathLease(collectionName: PhysicalCollectionName): Promise<() => void> {
    for (let held = this.pathLeases.get(collectionName); held; held = this.pathLeases.get(collectionName)) {
      await held;
    }
    let settle!: () => void;
    const lease = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pathLeases.set(collectionName, lease);
    return () => {
      if (this.pathLeases.get(collectionName) === lease) this.pathLeases.delete(collectionName);
      settle();
    };
  }

  /**
   * Retire the collection's cached client for a lease holder about to touch its
   * file: wait for an open already in flight, drop the client from the cache,
   * wait for every op pinned to it, close it, announce it. Returns whether a
   * client was retired. A close failure throws `DuckDbCloseFailedError` when
   * the caller is about to put or delete a file at the path, and is swallowed
   * when it only reads it.
   */
  private async retireForReplacement(
    collectionName: PhysicalCollectionName,
    onCloseFailure: "throw" | "swallow",
  ): Promise<boolean> {
    await this.inflight.get(collectionName)?.catch(() => undefined);
    const entry = this.clients.get(collectionName);
    if (!entry) return false;
    await this.retireEntry(collectionName, entry, onCloseFailure);
    return true;
  }

  /** Drop `entry` from the cache, drain its pinned ops, close and announce it. */
  private async retireEntry(
    collectionName: PhysicalCollectionName,
    entry: PoolEntry,
    onCloseFailure: "throw" | "swallow",
  ): Promise<void> {
    entry.retired = true;
    this.clients.delete(collectionName);
    this.lastUsedByCollection.delete(collectionName);
    if (entry.pinnedOps > 0) {
      await new Promise<void>((resolve) => {
        entry.drainWaiters.push(resolve);
      });
    }
    try {
      await entry.graphDb.close();
    } catch (err) {
      if (onCloseFailure === "throw") {
        throw new DuckDbCloseFailedError(this.pathFor(collectionName), err instanceof Error ? err : undefined);
      }
    } finally {
      this.options.onCollectionClientClosed?.(collectionName);
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
    for (const physicalCollectionName of [...this.clients.keys()]) {
      if ((this.opsInFlightByCollection.get(physicalCollectionName) ?? 0) > 0) continue;
      const lastUsed = this.lastUsedByCollection.get(physicalCollectionName);
      if (lastUsed === undefined || now - lastUsed < eviction.idleMs) continue;
      const idleSeconds = Math.round((now - lastUsed) / 1000);
      const evicted = await this.release(physicalCollectionName);
      if (evicted) {
        process.stderr.write(
          `[tea-rags] codegraph pool: evicted idle pool entry for ${physicalCollectionName} after ${idleSeconds}s idle\n`,
        );
      }
    }
  }

  /**
   * Drop the cached client for a collection (close + forget), e.g. to release the
   * file lock between test scenarios. Returns true when an entry was evicted.
   * Ops pinned to the client finish before it closes.
   */
  async release(physicalCollectionName: PhysicalCollectionName): Promise<boolean> {
    const entry = this.clients.get(physicalCollectionName);
    if (!entry) return false;
    await this.retireEntry(physicalCollectionName, entry, "swallow");
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
   *
   * Both paths are leased for the copy (bd tea-rags-mcp-r4veq): the source so
   * no op writes into it mid-copy, the target because the copy REPLACES it — a
   * client cached there is drained and closed first, so an op already running
   * on it finishes in the old file instead of writing into the successor's WAL.
   * A target client that fails to close throws `DuckDbCloseFailedError` and
   * nothing is published.
   */
  async cloneDatabase(
    sourcePhysicalCollectionName: PhysicalCollectionName,
    targetPhysicalCollectionName: PhysicalCollectionName,
  ): Promise<void> {
    await this.withPathLeases([sourcePhysicalCollectionName, targetPhysicalCollectionName], async () => {
      await this.retireForReplacement(sourcePhysicalCollectionName, "swallow");
      await this.retireForReplacement(targetPhysicalCollectionName, "throw");
      const replaced = await this.replaceInDaemon(async (daemon) =>
        daemon.cloneDatabase(sourcePhysicalCollectionName, targetPhysicalCollectionName),
      );
      if (replaced?.handledBy === "daemon") return;
      await this.dbFiles.cloneDatabase(sourcePhysicalCollectionName, targetPhysicalCollectionName);
    });
  }

  /**
   * Daemon mode: send a path replacement to the daemon, whose pool holds the
   * clients and so is the one that can drain them (bd tea-rags-mcp-r4veq).
   * `undefined` in direct mode — this pool holds every client itself. A
   * `caller` answer (no daemon running, unreachable, or an older build without
   * the op) leaves the files to this pool, the pre-r4veq behaviour.
   */
  private async replaceInDaemon(
    replace: (daemon: DaemonDatabaseFileReplacer) => Promise<DaemonDatabaseReplacement>,
  ): Promise<DaemonDatabaseReplacement | undefined> {
    const socketPath = this.options.daemonSocketPath;
    if (!socketPath) return undefined;
    // Dynamic so direct/test mode never loads the node:net socket code.
    const { DaemonDatabaseFileReplacer } = await import("./daemon/database-file-replacer.js");
    const replaced = await replace(new DaemonDatabaseFileReplacer(socketPath));
    if (replaced.handledBy === "caller" && isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph pool: daemon did not replace the database (${replaced.reason}) — this process does\n`,
      );
    }
    return replaced;
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
   * - The path's lease is held throughout (bd tea-rags-mcp-r4veq): ops pinned
   *   to the cached client finish before it closes and the file is unlinked,
   *   and ops issued meanwhile wait and open the path afresh afterwards.
   *
   * Returns true when a cached entry was evicted; disk cleanup runs regardless.
   */
  async removeCollection(physicalCollectionName: PhysicalCollectionName): Promise<boolean> {
    return this.withPathLeases([physicalCollectionName], async () => {
      const evicted = await this.retireForReplacement(physicalCollectionName, "throw");
      const replaced = await this.replaceInDaemon(async (daemon) => daemon.removeDatabase(physicalCollectionName));
      if (replaced?.handledBy === "daemon") return evicted || replaced.evicted;
      await this.dbFiles.removeFiles(physicalCollectionName);
      return evicted;
    });
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
      ...all.map(async ([physicalCollectionName, e]) => {
        e.retired = true;
        await e.graphDb.close().catch(() => undefined);
        this.options.onCollectionClientClosed?.(physicalCollectionName);
      }),
      ...daemons.map(async (e) => e.client.close().catch(() => undefined)),
    ]);
  }
}

/** End one op's pin; the last one out wakes a lease holder waiting to drain. */
function unpinClient(entry: PoolEntry): void {
  entry.pinnedOps -= 1;
  if (entry.pinnedOps > 0) return;
  for (const wake of entry.drainWaiters.splice(0)) wake();
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
