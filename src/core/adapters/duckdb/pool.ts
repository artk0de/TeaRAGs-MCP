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
 * next acquire. Another build's daemon merely HOLDING a file this pool must
 * open is settled at open time by `foreignBuildLockArbiter` (bd
 * tea-rags-mcp-hw27k).
 */

import { mkdirSync, statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";

import type { CollectionGraphHandle, GraphDbClientPoolPort } from "../../contracts/types/codegraph-pool.js";
import type { CallResolver, GlobalSymbolTable } from "../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import type { DatabaseMigrationApplier } from "../../contracts/types/migration.js";
import { isDebug } from "../../primitives/diagnostics/index.js";
import { DuckDbGraphClient } from "./client.js";
import { CodegraphDbFiles, sanitiseCollectionName } from "./codegraph-db-files.js";
import { CodegraphPathLeases } from "./codegraph-path-leases.js";
import { CollectionIdleEvictionTracker, type GraphDbClientPoolIdleEviction } from "./collection-idle-eviction.js";
import type { CollectionInitHook, SymbolTableFactory } from "./collection-init-hook.js";
import type {
  CodegraphDaemonClientTarget,
  CodegraphDatabaseFileReplacer,
  DaemonDatabaseReplacement,
  DaemonRouting,
  ForeignBuildLockArbiter,
} from "./daemon-ports.js";
import { CodegraphDatabaseMissingError, DuckDbCloseFailedError, DuckDbOpenFailedError } from "./errors.js";
import { LockContendedOpenRetry, type LockContendedOpenRetryWindow } from "./lock-contended-open-retry.js";
import { ReadOnlyGraphFileReaders } from "./read-only-graph-file-readers.js";
import { purgeStaleSpills } from "./spill-files.js";
import type { CodegraphCompactionPolicy } from "./storage-compaction.js";

export type { CollectionInitHook, GraphDbClientPoolIdleEviction, SymbolTableFactory };

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
   * Which daemon this client process addresses, re-decided at EVERY connect
   * (bd tea-rags-mcp-llrja). Wins over `daemonSocketPath`'s fixed address and
   * turns daemon mode on by itself. The bootstrap factory wires it to
   * `resolveDaemonClientTarget` — the rule its spawner resolves through too —
   * because the build on disk moves under a long-lived process: after a
   * rebuild the daemon this tree spawns keys itself by the NEW build, so a
   * wire-time socket of the loaded build names a dir nothing listens in. The
   * build handshake then settles what a stale process may do there. A target
   * whose build tree is gone, with no daemon of the loaded build listening,
   * fails at once with `CodegraphClientBuildTreeGoneError`. Worker-thread
   * pools omit it: runs are admitted only while loaded == on disk (bd
   * tea-rags-mcp-r4z09), where the rule yields the wire-time socket.
   */
  daemonClientTarget?: () => CodegraphDaemonClientTarget;
  /**
   * How this pool reaches the daemon in daemon mode (bd tea-rags-mcp-89k7k.35,
   * H4a2): the cached per-collection clients AND the database-file replacer
   * factory. The pool consumes it and constructs none of the daemon classes —
   * the composition root builds it (`createDaemonRouting` in
   * `daemon/index.ts`, wrapping `DaemonCollectionClientCache` +
   * `DaemonBuildHandshakeConnector` + `DaemonDatabaseFileReplacer` and carrying
   * the daemon-construction options that used to sit here: `daemonStorageDir`,
   * `daemonRestart`). REQUIRED whenever daemon mode is on (`daemonSocketPath`
   * or `daemonClientTarget` set): a pool wired for the daemon without a way to
   * reach it is a construction bug and fails at once.
   */
  daemonRouting?: DaemonRouting;
  /**
   * Bounded retry for the collection OPEN (bd tea-rags-mcp-42hno). When set,
   * a `DuckDbOpenFailedError` from the open is retried every `intervalMs`
   * until `maxMs` elapses, then the last error rethrown. The DAEMON wires it
   * (its pool is the only one that opens files in daemon mode): with two
   * build-keyed daemons on one machine, both serve the same on-disk
   * collections, so a loser's open waits out the winner's idle eviction
   * (nlls) instead of failing the op. Without it the open fails immediately.
   */
  openRetry?: LockContendedOpenRetryWindow;
  /**
   * Settles an open that lost the file lock to ANOTHER build's codegraph
   * daemon (bd tea-rags-mcp-hw27k) — the daemon wires it beside `openRetry`.
   * A foreign daemon with no client connected is drained and the open retried
   * at once; one still in use is waited for within the `openRetry` window and
   * then named in `CodegraphDatabaseHeldByForeignDaemonError`, and a later open
   * of the same collection against that same holder fails at once instead of
   * waiting the window again. Without it every holder gets the plain retry.
   */
  foreignBuildLockArbiter?: ForeignBuildLockArbiter;
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

export type { CollectionGraphHandle };

export class GraphDbClientPool implements GraphDbClientPoolPort {
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
  /** Path leases of in-process replacers — what `acquire` waits out and a pin re-checks. */
  private readonly pathLeases = new CodegraphPathLeases();
  /** Only when `idleEviction` is wired (bd tea-rags-mcp-nlls). */
  private readonly idleEviction: CollectionIdleEvictionTracker | undefined;
  /** Retries an open that lost the file lock; remembers foreign-build holders. */
  private readonly lockContendedOpen: LockContendedOpenRetry;
  /** READ_ONLY file handles, counted per path. */
  private readonly fileReaders: ReadOnlyGraphFileReaders;

  constructor(private readonly options: GraphDbClientPoolOptions) {
    this.dbFiles = new CodegraphDbFiles(options.rootDir);
    // Daemon mode without a routing is a construction bug (H4a2): the clients
    // and the replacer live behind `daemonRouting`, nothing constructs them
    // here anymore. Programming error, so a plain Error is the right class.
    if (
      (options.daemonSocketPath !== undefined || options.daemonClientTarget !== undefined) &&
      options.daemonRouting === undefined
    ) {
      throw new Error(
        "GraphDbClientPool: daemon mode (daemonSocketPath / daemonClientTarget) requires daemonRouting — " +
          "build it with createDaemonRouting (adapters/duckdb/daemon)",
      );
    }
    this.idleEviction = options.idleEviction
      ? new CollectionIdleEvictionTracker(options.idleEviction, {
          cachedCollections: () => [...this.clients.keys()],
          release: async (physicalCollectionName) => this.release(physicalCollectionName),
        })
      : undefined;
    this.lockContendedOpen = new LockContendedOpenRetry({
      openRetry: options.openRetry,
      foreignBuildLockArbiter: options.foreignBuildLockArbiter,
      pathFor: (physicalCollectionName) => this.pathFor(physicalCollectionName),
    });
    this.fileReaders = new ReadOnlyGraphFileReaders(options.symbolTableFactory);
    mkdirSync(this.codegraphDir, { recursive: true });
    // Reclaim crashed runs' spills per ENTRY, never the whole directory (bd
    // tea-rags-mcp-v6gxr): pools are built mid-flight by unpinned enrichment
    // workers, the daemon and concurrent CLI runs, and `purgeStaleSpills` keeps
    // whatever a live pid owns. Also recreates the dir for `SET temp_directory`.
    purgeStaleSpills(this.spillDir);
    this.idleEviction?.start();
  }

  private get codegraphDir(): string {
    return this.dbFiles.dir;
  }

  /**
   * The daemon routing — present whenever daemon mode is on (the constructor
   * refuses anything else), so the throw below is unreachable in practice and
   * only narrows the type.
   */
  private get daemonRouting(): DaemonRouting {
    const routing = this.options.daemonRouting;
    if (!routing) {
      throw new Error("GraphDbClientPool: daemonRouting is required in daemon mode");
    }
    return routing;
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
   * A stamp of the database's on-disk state that moves on EVERY committed write
   * (bd tea-rags-mcp-nehn5): identity, size, mtime and ctime (ns) of the
   * database file and of its `.wal`. A commit appends to the WAL, a checkpoint
   * rewrites the database file, a replacement changes the inode — so an index
   * run, a recompute that leaves the indexed commit alone, and a fold of the
   * WAL all move it, whichever process wrote. A long-lived process keys cached
   * whole-database reads by it; take it BEFORE the read, so a write racing the
   * read leaves the entry under the older stamp. `undefined` = no database.
   */
  databaseWriteStamp(physicalCollectionName: PhysicalCollectionName): string | undefined {
    const dbPath = this.pathFor(physicalCollectionName);
    const dbStats = statSync(dbPath, { bigint: true, throwIfNoEntry: false });
    if (dbStats === undefined) return undefined;
    const walStats = statSync(`${dbPath}.wal`, { bigint: true, throwIfNoEntry: false });
    return `${dbPath}|${fileStateStamp(dbStats)}|${walStats === undefined ? "no-wal" : fileStateStamp(walStats)}`;
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
    // Guarded so an unleased acquire stays free of an extra microtask turn.
    if (this.pathLeases.isHeld(physicalCollectionName)) await this.pathLeases.waitForRelease(physicalCollectionName);
    // The idle-eviction clock starts here even for acquires that bypass
    // `runCollectionOp` (the daemon handshake's open-and-drop), so an opened
    // collection nobody ever ops against still becomes evictable.
    this.idleEviction?.stampUse(physicalCollectionName);
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

  /** Daemon mode: a fixed daemon socket, or a client target re-resolved per connect. */
  private isDaemonMode(): boolean {
    return Boolean(this.options.daemonSocketPath) || this.options.daemonClientTarget !== undefined;
  }

  /**
   * Acquire a WRITE handle: through the daemon (the single RW connection across
   * processes) in daemon mode, else the in-process RW handle (`acquire`).
   */
  async acquireWrite(physicalCollectionName: PhysicalCollectionName): Promise<CollectionGraphHandle> {
    if (this.isDaemonMode()) {
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
    return this.daemonRouting.clients.acquireHandle(physicalCollectionName);
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
    return this.acquireFileReader(this.pathFor(physicalCollectionName));
  }

  /**
   * In-process READ_ONLY handle on a graph file this pool does not own — the
   * working tree's published graph (bd tea-rags-mcp-xi2r9, WTO-7), a
   * self-contained file no daemon holds, so even daemon mode attaches it
   * directly. NON-cached: the caller MUST close it.
   *
   * @throws DuckDbOpenFailedError when the file cannot be opened.
   */
  async acquireFileReader(dbPath: string): Promise<CollectionGraphHandle> {
    return this.fileReaders.acquire(dbPath);
  }

  /**
   * Whether a handle from {@link acquireFileReader} on `dbPath` is open in this
   * process — what the working-tree graph cache asks before it deletes a
   * superseded tree graph (bd tea-rags-mcp-xi2r9, D5). Process-local by nature:
   * a reader in another server is covered by the cache's grace, not by this.
   */
  isFileReaderOpen(dbPath: string): boolean {
    return this.fileReaders.isOpen(dbPath);
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
    if (this.isDaemonMode()) {
      return this.acquireDaemonHandle(physicalCollectionName);
    }
    return this.acquireRead(physicalCollectionName);
  }

  /**
   * Write a consistent copy of the collection's graph to `targetPath` (bd
   * tea-rags-mcp-xi2r9, WTO-7) — taken by whoever holds the file, because only
   * the holder sees the rows its WAL keeps (`DuckDbGraphSession#exportSnapshot`):
   *
   * - daemon mode — the daemon, over its own connection (`exportSnapshot` op);
   * - direct mode with a read-write client cached in this pool — that client,
   *   as a pinned collection op. A READ_ONLY attach beside it would be refused
   *   by the lock it holds; the client stays cached afterwards;
   * - direct mode otherwise — a READ_ONLY attach, closed once the copy is done.
   *
   * Like `acquireReader`, it never creates the database it is asked to copy.
   *
   * @throws CodegraphDatabaseMissingError when the collection has no database.
   * @throws CodegraphSnapshotExportFailedError when the copy or its publish fails,
   *   or the running daemon predates the op.
   */
  async exportSnapshot(physicalCollectionName: PhysicalCollectionName, targetPath: string): Promise<void> {
    if (!this.hasDatabase(physicalCollectionName)) {
      throw new CodegraphDatabaseMissingError(this.pathFor(physicalCollectionName));
    }
    if (this.isDaemonMode()) {
      const { graphDb } = await this.acquireDaemonHandle(physicalCollectionName);
      await graphDb.exportSnapshot(targetPath);
      return;
    }
    if (this.clients.has(physicalCollectionName)) {
      await this.runCollectionOp(physicalCollectionName, async ({ graphDb }) => graphDb.exportSnapshot(targetPath));
      return;
    }
    const { graphDb } = await this.acquireRead(physicalCollectionName);
    try {
      await graphDb.exportSnapshot(targetPath);
    } finally {
      await graphDb.close();
    }
  }

  /**
   * Open the collection, retrying an open that lost the file lock — bounded by
   * `openRetry`, foreign-build holders settled by `foreignBuildLockArbiter`
   * (`LockContendedOpenRetry`, bd tea-rags-mcp-42hno, hw27k).
   */
  private async openCollection(physicalCollectionName: PhysicalCollectionName): Promise<PoolEntry> {
    return this.lockContendedOpen.open(physicalCollectionName, async () =>
      this.openCollectionOnce(physicalCollectionName),
    );
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
    this.idleEviction?.beginOp(physicalCollectionName);
    try {
      const entry = await this.pinClient(physicalCollectionName);
      try {
        return await op(entry);
      } finally {
        unpinClient(entry);
      }
    } finally {
      this.idleEviction?.endOp(physicalCollectionName);
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
      if (!entry.retired && !this.pathLeases.isHeld(collectionName)) {
        entry.pinnedOps += 1;
        return entry;
      }
    }
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
    this.idleEviction?.forget(collectionName);
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
    await this.pathLeases.withLeases([sourcePhysicalCollectionName, targetPhysicalCollectionName], async () => {
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
    replace: (daemon: CodegraphDatabaseFileReplacer) => Promise<DaemonDatabaseReplacement>,
  ): Promise<DaemonDatabaseReplacement | undefined> {
    const socketPath = this.options.daemonClientTarget?.().paths.socketPath ?? this.options.daemonSocketPath;
    if (!socketPath) return undefined;
    const replaced = await replace(this.daemonRouting.replacerFor(socketPath));
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
    return this.pathLeases.withLeases([physicalCollectionName], async () => {
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
    this.idleEviction?.clear();
    await Promise.all([
      ...all.map(async ([physicalCollectionName, e]) => {
        e.retired = true;
        await e.graphDb.close().catch(() => undefined);
        this.options.onCollectionClientClosed?.(physicalCollectionName);
      }),
      // Undefined in direct mode — no daemon sockets to close. The routing
      // always exists in daemon mode (constructor guard).
      this.options.daemonRouting?.clients.closeAll(),
    ]);
  }
}

/** End one op's pin; the last one out wakes a lease holder waiting to drain. */
/** One file's on-disk state, as `GraphDbClientPool#databaseWriteStamp` compares it. */
function fileStateStamp(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

function unpinClient(entry: PoolEntry): void {
  entry.pinnedOps -= 1;
  if (entry.pinnedOps > 0) return;
  for (const wake of entry.drainWaiters.splice(0)) wake();
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
