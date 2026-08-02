/**
 * Per-collection DuckDB pool for codegraph isolation.
 *
 * Each indexed project (Qdrant collection) owns its own
 * `<dataDir>/codegraph/<collectionName>.duckdb` file. The pool lazily
 * opens / initialises a `DuckDbGraphClient` on the first request for a
 * given collection, runs the schema migrations once, and caches the
 * client for subsequent calls.
 *
 * Why per-file:
 * 1. DuckDB is single-writer per file. A shared DB blocks new MCP
 *    processes when an older one holds the lock — silently disabling
 *    codegraph for every project. Per-collection files isolate that
 *    lock to within a single project.
 * 2. The slice 1 schema has no `collection_id` column on the
 *    `cg_symbols_*` tables. Indexing two projects against one DB would
 *    collide on PKs (e.g. both repos with a `README.md` -> duplicate
 *    `cg_symbols_files.rel_path` row). Separate files mean no collision.
 *
 * The pool intentionally has no cap on open instances — tea-rags
 * registers a small number of projects in practice (single digits),
 * and each open DB costs ~one file handle + a small in-memory symbol
 * table. The `release(collectionName)` helper exists for tests that
 * need to reset state.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CallResolver, GlobalSymbolTable, GraphDbClient } from "../../contracts/types/codegraph.js";
import type { DatabaseMigrationApplier } from "../../contracts/types/migration.js";
import { isDebug } from "../../infra/runtime.js";
import { DuckDbGraphClient } from "./client.js";
import { getBuildFingerprint } from "./daemon/build-fingerprint.js";
import type { DaemonGraphDbClient } from "./daemon/client.js";
import { DEFAULT_EXIT_TIMEOUT_MS, getDaemonPaths, readDaemonPid, waitForDaemonExit } from "./daemon/lifecycle.js";
import {
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
} from "./errors.js";

/**
 * Initialiser hook the pool calls once per newly-opened collection
 * client. Receives the per-collection symbol table so the caller can
 * hydrate it from disk. The pool itself does not import the in-memory
 * symbol-table implementation — that lives in the codegraph domain.
 */
export type CollectionInitHook = (args: {
  collectionName: string;
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}) => Promise<void>;

export type SymbolTableFactory = () => GlobalSymbolTable;

export interface GraphDbClientPoolOptions {
  /** Root directory; per-collection files go in `<rootDir>/codegraph/`. */
  rootDir: string;
  /** Factory for the per-collection in-memory symbol table. */
  symbolTableFactory: SymbolTableFactory;
  /**
   * Hook called once per collection after migrations apply. Used by the
   * codegraph trajectory to hydrate the symbol table from the freshly
   * opened DB.
   */
  initHook?: CollectionInitHook;
  /**
   * Slice 2 — per-DuckDB resource ceiling applied at init time on
   * every opened collection. See `DuckDbGraphClientOptions.resources`.
   * `tempDirectory` is auto-derived from `rootDir` when omitted so all
   * pool-managed collections share one spill directory; callers can
   * override for tests.
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
   * Unix socket of the running codegraph daemon. When set, `acquireWrite`
   * routes mutations through a `DaemonGraphDbClient` over this socket — the
   * single daemon process holds the RW DuckDB lock so concurrent MCP
   * processes never contend on it. When absent (direct/test mode),
   * `acquireWrite` falls back to the in-process RW handle (`acquire`).
   * Reads (`acquireRead`) always go in-process READ_ONLY and ignore this.
   */
  daemonSocketPath?: string;
  /**
   * Build-version handshake restart wiring (bd tea-rags-mcp-ji56r), daemon
   * mode only. When the daemon's handshake fingerprint differs from ours, the
   * pool drains it (graceful `shutdown` op), waits for its lifecycle files to
   * clear, invokes `respawn` to cold-spawn a daemon from THIS build, and
   * reconnects (one retry max). Absent fingerprint on either side (legacy
   * peer) → no restart, proceed as before.
   */
  daemonRestart?: {
    /** Cold-spawn hook — wired to `ensureCodegraphDaemon` by the bootstrap factory. */
    respawn?: () => void;
    /** Override the module-computed local fingerprint (tests). */
    buildFingerprint?: string;
    /** Bound on the wait for the stale daemon's exit (default 10s). */
    exitTimeoutMs?: number;
    /** Lifecycle-file poll interval while waiting for the exit. */
    pollIntervalMs?: number;
  };
}

interface PoolEntry {
  graphDb: DuckDbGraphClient;
  symbolTable: GlobalSymbolTable;
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
   * ONE in-memory symbol table per collection, shared across every
   * acquireWrite/acquireReader for that collection (same lifecycle as the
   * cached daemon client). Codegraph ingest does getStore-per-file-write and
   * resolves method calls at finish against this table — a fresh table per
   * acquire (the prior bug) lost every cross-file symbol, collapsing
   * method-edge resolution. Mirrors the cached `entry.symbolTable` of the
   * in-process `acquire` path.
   */
  symbolTable: GlobalSymbolTable;
}

export interface CollectionGraphHandle {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}

/**
 * Sanitise the collection name to a filesystem-safe leaf. The Qdrant
 * collection names tea-rags uses today (`code_<hex>` + ad-hoc CLI names)
 * are already safe, but defend against future shapes containing path
 * separators or control characters.
 */
function sanitiseCollectionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Escape regex metacharacters in a (sanitised) collection name before
 * embedding it in the versioned-DB-file pattern. Sanitised names may still
 * contain `.` and `-`, which are regex-meaningful.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class GraphDbClientPool {
  private readonly clients = new Map<string, PoolEntry>();
  /**
   * In-flight open promises so concurrent first-callers for the same
   * collection share a single init pass (avoids racing migrations on
   * the same file).
   */
  private readonly inflight = new Map<string, Promise<CollectionGraphHandle>>();
  /**
   * Daemon mode only: ONE `DaemonGraphDbClient` per collection (a single unix
   * socket per (collection, process)). `acquireWrite` / `acquireReader` reuse
   * the cached client instead of opening a fresh socket per call — the client
   * multiplexes concurrent requests by id, so one socket is enough. Closed in
   * `closeAll` so the daemon-side per-connection refcount decrements when this
   * process exits, letting the idle watcher fire and release the RW lock.
   */
  private readonly daemonClients = new Map<string, DaemonClientEntry>();
  /** In-flight daemon-client init so concurrent first-callers share one socket. */
  private readonly daemonInflight = new Map<string, Promise<DaemonClientEntry>>();

  constructor(private readonly options: GraphDbClientPoolOptions) {
    mkdirSync(this.codegraphDir, { recursive: true });
    // Slice 2 — purge stale NDJSON spill files left by a prior
    // process that crashed before its sink.finish() ran. Idempotent;
    // runs ONCE at pool construction (not on every acquire) so a
    // long-running process indexing two collections concurrently
    // does NOT have its in-flight spill wiped when the second
    // collection opens its DB. The directory is recreated empty
    // immediately so the first acquire's DuckDB init can SET
    // temp_directory against an existing path.
    try {
      rmSync(this.spillDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a permission error here is not worth aborting
      // pool construction over. The DuckDB temp_directory setting
      // also tolerates the dir being missing — driver creates lazily.
    }
    mkdirSync(this.spillDir, { recursive: true });
  }

  private get codegraphDir(): string {
    return join(this.options.rootDir, "codegraph");
  }

  /**
   * Per-pool spill directory under the codegraph root. Each opened
   * `DuckDbGraphClient.init()` purges and recreates it (cleanup of
   * stale spill files from a prior crashed process). Exposed via
   * `pathFor*` helpers below for tests.
   */
  private get spillDir(): string {
    return this.options.resources?.tempDirectory ?? join(this.codegraphDir, ".spill");
  }

  /** Resolve the disk path for a given collection name. Exposed for tests. */
  pathFor(collectionName: string): string {
    return join(this.codegraphDir, `${sanitiseCollectionName(collectionName)}.duckdb`);
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
  hasDatabase(collectionName: string): boolean {
    return existsSync(this.pathFor(collectionName));
  }

  /**
   * Enumerate the versioned codegraph DB collection names on disk for a base
   * collection — every `<base>_v<N>.duckdb` file in the codegraph dir, returned
   * as the collection name (suffix stripped). Used by the orphan sweep to find
   * ancient per-version DuckDB files whose Qdrant collection no longer exists
   * (the sweep deletes those that are neither the active alias target nor backed
   * by a live Qdrant collection).
   *
   * Includes the UNVERSIONED `<base>.duckdb` too (bd tea-rags-mcp-6goqa). It
   * used to be excluded, which is exactly why the shadow file the incremental
   * path wrote while addressing collections by their alias was invisible to the
   * sweep and could never be reclaimed. Returning it is safe because the sweep
   * skips any name that is the active alias target or is backed by a live
   * Qdrant collection — and a genuinely unversioned, non-aliased project is the
   * latter.
   *
   * Still scoped to `^<base>(_v\d+)?$` so it never touches another project's
   * DBs or WAL/spill sidecars. Returns an empty array when the codegraph dir is
   * missing (nothing indexed yet).
   */
  listCollectionDbNames(baseCollectionName: string): string[] {
    const base = sanitiseCollectionName(baseCollectionName);
    const pattern = new RegExp(`^(${escapeRegExp(base)}(?:_v\\d+)?)\\.duckdb$`);
    let entries: string[];
    try {
      entries = readdirSync(this.codegraphDir);
    } catch {
      // Codegraph dir missing (never constructed / removed) — nothing to sweep.
      return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) names.push(match[1]);
    }
    return names;
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
   * yl9tv Task 5b — deterministic per-collection cross-pass INPUT spill path.
   * The full-index chunk pass (main thread) sync-appends each file's
   * `FileExtraction` here; the off-thread codegraph worker drains it in
   * `finalizeSignals`. Lives in `.xpass`, a SIBLING of `.spill` that the pool
   * constructor does NOT `rmSync` — critical, because the worker constructs its
   * OWN pool mid-run (first dispatch) and would otherwise wipe the in-flight
   * input spill the main thread is still writing. Deterministic (no runId): both
   * the main and worker pools share `rootDir`, so both resolve the identical
   * path. The provider truncates it at run start (`beginExtractionRun`) and
   * removes it after draining, so a crashed run leaves at most one stale file
   * that the next run overwrites.
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
   */
  peek(collectionName: string): CollectionGraphHandle | undefined {
    return this.clients.get(collectionName);
  }

  /**
   * Open (lazily) and return the handle for `collectionName`. First call
   * for a name creates the file, runs migrations, invokes the init hook
   * to hydrate the symbol table, then caches the result. Concurrent
   * first-callers share one open pass via the inflight map.
   */
  async acquire(collectionName: string): Promise<CollectionGraphHandle> {
    const cached = this.clients.get(collectionName);
    if (cached) return cached;
    const inflight = this.inflight.get(collectionName);
    if (inflight) return inflight;

    const promise = this.openCollection(collectionName).finally(() => {
      this.inflight.delete(collectionName);
    });
    this.inflight.set(collectionName, promise);
    return promise;
  }

  /**
   * Acquire a WRITE handle for `collectionName`. When `daemonSocketPath`
   * is configured, returns a `DaemonGraphDbClient` that proxies mutations
   * to the daemon (which owns the single RW DuckDB connection across all
   * processes). Otherwise delegates to the in-process RW path (`acquire`)
   * for direct/test mode.
   *
   * The import is dynamic so the daemon client module is only loaded when
   * daemon mode is actually wired — direct/test mode never touches the
   * `node:net` socket code.
   */
  async acquireWrite(collectionName: string): Promise<CollectionGraphHandle> {
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(collectionName);
    }
    return this.acquire(collectionName);
  }

  /**
   * Return a handle backed by the ONE cached `DaemonGraphDbClient` for
   * `collectionName` (lazily created + init'd on first use, reused after).
   * The handle's `graphDb` is a thin proxy whose `close()` is a NO-OP — the
   * pool owns the real socket close via `closeAll`. If a per-call `close()`
   * ended the shared socket, the next acquire would have to reconnect (the
   * leak this fix removes), and `GraphFacade.withReadHandle`'s `finally`
   * close would tear down the socket other in-flight callers share.
   */
  private async acquireDaemonHandle(collectionName: string): Promise<CollectionGraphHandle> {
    const entry = await this.acquireDaemonClient(collectionName);
    return { graphDb: entry.wrapped, symbolTable: entry.symbolTable };
  }

  /**
   * Lazily create + init the single cached `DaemonGraphDbClient` for a
   * collection (plus its stable no-op-close wrapper). Concurrent first-callers
   * share one init pass via `daemonInflight` (no duplicate sockets during a
   * burst of acquires).
   */
  private async acquireDaemonClient(collectionName: string): Promise<DaemonClientEntry> {
    const cached = this.daemonClients.get(collectionName);
    if (cached) return cached;
    const inflight = this.daemonInflight.get(collectionName);
    if (inflight) return inflight;

    const socketPath = this.options.daemonSocketPath;
    /* v8 ignore next -- acquireDaemonClient is only reached when daemonSocketPath is set */
    if (!socketPath) throw new Error("acquireDaemonClient called without daemonSocketPath");

    const promise = (async (): Promise<DaemonClientEntry> => {
      const client = await this.connectWithBuildHandshake(socketPath, collectionName);
      const wrapped = wrapNoopClose(client);
      // One shared symbol table per collection (see DaemonClientEntry doc).
      // Hydrate it from the daemon's DuckDB via the init hook — mirrors
      // openCollection so cross-file / incremental-reindex resolution sees
      // symbols from files NOT re-walked this run. Non-fatal on failure:
      // the table just starts empty and the next ingest pass repopulates.
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
   * Connect to the daemon and exchange build fingerprints (bd
   * tea-rags-mcp-ji56r). Same build or a legacy peer (no fingerprint in the
   * response) → return the connected client, exactly as before. A DIFFERENT
   * fingerprint means the daemon runs stale code (spawned before the last
   * `npm run build` / `npm link` flip): drain it gracefully, cold-spawn a
   * fresh daemon from THIS build via the respawn hook, reconnect, and
   * re-verify — one retry max, then a typed error.
   */
  private async connectWithBuildHandshake(socketPath: string, collectionName: string): Promise<DaemonGraphDbClient> {
    // Dynamic so direct/test mode never loads the node:net socket code.
    const { DaemonGraphDbClient } = await import("./daemon/client.js");
    const restart = this.options.daemonRestart;
    const localFingerprint = restart?.buildFingerprint ?? getBuildFingerprint();

    const first = new DaemonGraphDbClient(socketPath, collectionName);
    await first.init();
    const daemonFingerprint = (await first.handshake(localFingerprint))?.buildFingerprint;
    // Legacy daemon (no fingerprint) or same build → proceed as today.
    if (daemonFingerprint === undefined || daemonFingerprint === localFingerprint) return first;

    // Restart is gated on a wired respawn hook: draining a daemon this pool
    // cannot cold-spawn again (worker-thread pools rebuilt from serializable
    // config) would strand codegraph for every process on the machine. Such
    // pools TOLERATE the stale daemon — the main MCP process, whose factory
    // wires the hook, performs the actual restart.
    const respawn = restart?.respawn;
    if (!respawn) {
      if (isDebug()) {
        process.stderr.write(
          `[tea-rags] codegraph daemon build mismatch (daemon=${daemonFingerprint}, ` +
            `client=${localFingerprint}) — no respawn hook wired, proceeding with the running daemon\n`,
        );
      }
      return first;
    }

    if (isDebug()) {
      process.stderr.write(
        `[tea-rags] codegraph daemon build mismatch (daemon=${daemonFingerprint}, ` +
          `client=${localFingerprint}) — draining stale daemon and respawning from this build\n`,
      );
    }
    await this.drainStaleDaemon(first, socketPath);
    respawn();

    // One retry: reconnect (init retries the connect while the fresh daemon
    // boots) and re-verify the fingerprint.
    const second = new DaemonGraphDbClient(socketPath, collectionName);
    await second.init();
    const retryFingerprint = (await second.handshake(localFingerprint))?.buildFingerprint;
    if (retryFingerprint !== undefined && retryFingerprint !== localFingerprint) {
      await second.close();
      throw new CodegraphDaemonStaleBuildError(socketPath, localFingerprint, retryFingerprint);
    }
    return second;
  }

  /**
   * Gracefully retire a stale daemon: request the drain (acked, then the
   * daemon reuses its idle-watcher teardown), close our socket so the daemon's
   * `server.close` is not held open by us, and poll the lifecycle files until
   * the old process is gone. Times out with a typed error — never cold-spawns
   * on top of a daemon that still holds the socket + RW lock.
   */
  private async drainStaleDaemon(client: DaemonGraphDbClient, socketPath: string): Promise<void> {
    // The lifecycle files live next to the socket (getDaemonPaths layout).
    const paths = getDaemonPaths(dirname(socketPath));
    const stalePid = readDaemonPid(paths);
    await client.requestShutdown().catch(() => undefined);
    await client.close();
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
   * Acquire a READ-ONLY handle for `collectionName`. Always opens the live
   * versioned DuckDB file in-process with `access_mode=READ_ONLY` — DuckDB
   * permits unlimited concurrent cross-process readers, so this never
   * contends with the daemon's RW lock. The full (unstripped) collection
   * name resolves the same `<collection>.duckdb` file the write path
   * populated.
   *
   * The returned handle is NOT cached in `clients` (each reader opens its
   * own RO connection); callers MUST `close()` the returned `graphDb` when
   * done — `closeAll`/`release` only manage the cached RW entries.
   */
  async acquireRead(collectionName: string): Promise<CollectionGraphHandle> {
    const graphDb = new DuckDbGraphClient({
      path: this.pathFor(collectionName),
      accessMode: "READ_ONLY",
    });
    await graphDb.init();
    return { graphDb, symbolTable: this.options.symbolTableFactory() };
  }

  /**
   * Mode-aware READ handle for the GraphFacade. When `daemonSocketPath` is
   * configured (production), returns a `DaemonGraphDbClient` that PROXIES the
   * facade reads (`getCallers` / `getCallees` / `findCycles` / `getCalleeEdges`) through the
   * daemon's own RW connection — DuckDB's RW lock is process-exclusive, so a
   * cross-process READ_ONLY attach throws "Conflicting lock is held" while the
   * daemon holds RW. Routing reads through the daemon (the sole file opener)
   * eliminates the conflict entirely. In direct/test mode (no socket) falls back
   * to the in-process READ_ONLY attach (`acquireRead`).
   *
   * Either handle's `close()` is safe to call in the facade's `finally`: in
   * daemon mode it is a NO-OP (the pool owns the ONE cached socket per
   * collection, closed in `closeAll`); in direct/test mode the in-process RO
   * handle closes its own file.
   */
  async acquireReader(collectionName: string): Promise<CollectionGraphHandle> {
    if (this.options.daemonSocketPath) {
      return this.acquireDaemonHandle(collectionName);
    }
    return this.acquireRead(collectionName);
  }

  private async openCollection(collectionName: string): Promise<CollectionGraphHandle> {
    const dbPath = this.pathFor(collectionName);
    const graphDb = new DuckDbGraphClient({
      path: dbPath,
      resources: {
        memoryLimit: this.options.resources?.memoryLimit,
        threads: this.options.resources?.threads,
        tempDirectory: this.spillDir,
        preserveInsertionOrder: this.options.resources?.preserveInsertionOrder,
      },
    });
    try {
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
        await this.options.initHook({ collectionName, graphDb, symbolTable });
      } catch (err) {
        // Init-hook failure (e.g. hydration query) is non-fatal: the
        // DB is open, the symbol table just starts empty. Next ingest
        // pass repopulates affected files.
        process.stderr.write(
          `[tea-rags] codegraph init-hook failed for ${collectionName}: ${(err as Error).message}\n`,
        );
      }
    }

    const entry: PoolEntry = { graphDb, symbolTable };
    this.clients.set(collectionName, entry);
    return entry;
  }

  /**
   * Drop the cached client for a collection (close + forget). Used by
   * `clearIndex` paths in the future and by tests that need to release
   * the file lock between scenarios. Returns true when an entry was
   * actually evicted.
   */
  async release(collectionName: string): Promise<boolean> {
    const entry = this.clients.get(collectionName);
    if (!entry) return false;
    this.clients.delete(collectionName);
    await entry.graphDb.close().catch(() => undefined);
    return true;
  }

  /**
   * Copy the DuckDB file for sourceCollection to targetCollection, WAL sidecar
   * included. No-op when the source file does not exist (codegraph disabled /
   * not built).
   *
   * The `.wal` travels with the database because the database file alone is
   * only the state as of its last checkpoint — everything written since lives
   * in the sidecar, and a clone that drops it is silently rolled back to that
   * checkpoint. Mirrors `removeCollection`, which has always treated the pair
   * as one artifact. A target WAL with no source counterpart is REMOVED rather
   * than left: collection names get reused, and replaying a previous tenant's
   * write log over a freshly copied database is worse than the truncation this
   * copy avoids.
   *
   * `release` drops this process's cached client, which checkpoints on close —
   * but ONLY when the client is in this pool's cache. A database held by the
   * codegraph daemon (or any other process) is not released here and keeps an
   * unflushed WAL, which is exactly why the sidecar has to be copied instead of
   * assumed empty.
   */
  async cloneDatabase(sourceCollection: string, targetCollection: string): Promise<void> {
    await this.release(sourceCollection);
    const from = this.pathFor(sourceCollection);
    if (!existsSync(from)) return;
    const to = this.pathFor(targetCollection);
    mkdirSync(dirname(to), { recursive: true });
    await copyFile(from, to);
    if (existsSync(`${from}.wal`)) await copyFile(`${from}.wal`, `${to}.wal`);
    else await unlink(`${to}.wal`).catch(() => undefined);
  }

  /**
   * Drop the cached client for a collection AND delete its on-disk
   * DuckDB file (plus WAL sidecar). Used by the clear / delete /
   * force-reindex paths in IngestFacade and CollectionOps so the
   * per-collection codegraph DB does not outlive the Qdrant collection
   * it shadows.
   *
   * Contract:
   * - Closes the cached connection first (if any). Close failure throws
   *   `DuckDbCloseFailedError` — the disk file is NOT unlinked when the
   *   driver rejects close, since unlinking a file the driver still
   *   holds open is undefined behaviour on some platforms.
   * - Unlink errors are swallowed when the file is already gone (ENOENT
   *   — makes the method idempotent). Other unlink errors are also
   *   swallowed because the eviction-from-cache step has already
   *   succeeded; a stale file on disk is preferable to leaving the pool
   *   half-mutated, and a subsequent `acquire` will simply overwrite it.
   *
   * Returns true when a cached entry was evicted; the disk-side cleanup
   * happens regardless of whether the entry was cached.
   */
  async removeCollection(collectionName: string): Promise<boolean> {
    const dbPath = this.pathFor(collectionName);
    const entry = this.clients.get(collectionName);
    let evicted = false;
    if (entry) {
      this.clients.delete(collectionName);
      try {
        await entry.graphDb.close();
      } catch (err) {
        throw new DuckDbCloseFailedError(dbPath, err instanceof Error ? err : undefined);
      }
      evicted = true;
    }
    await unlink(dbPath).catch(() => undefined);
    await unlink(`${dbPath}.wal`).catch(() => undefined);
    return evicted;
  }

  /**
   * Close every cached client — both the in-process RW clients AND the cached
   * daemon-mode socket clients. Idempotent. Used at shutdown.
   *
   * Closing the daemon clients ends their unix sockets, which fires the
   * daemon-side per-connection `close` handler (`decrementRefs`). When the last
   * client process closes, the daemon's refcount reaches 0 and its idle watcher
   * tears it down, releasing the RW DuckDB lock. Without this, the sockets stay
   * open until the process dies and the daemon never sees refs hit 0.
   */
  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    const daemons = [...this.daemonClients.values()];
    this.daemonClients.clear();
    await Promise.all([
      ...all.map(async (e) => e.graphDb.close().catch(() => undefined)),
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
  }) as unknown as GraphDbClient;
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
