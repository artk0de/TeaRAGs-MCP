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

import { mkdirSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import type { CallResolver, GlobalSymbolTable, GraphDbClient } from "../../contracts/types/codegraph.js";
import { DuckDbGraphClient } from "./client.js";
import { DuckDbCloseFailedError, DuckDbOpenFailedError } from "./errors.js";

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
}

interface PoolEntry {
  graphDb: DuckDbGraphClient;
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

export class GraphDbClientPool {
  private readonly clients = new Map<string, PoolEntry>();
  /**
   * In-flight open promises so concurrent first-callers for the same
   * collection share a single init pass (avoids racing migrations on
   * the same file).
   */
  private readonly inflight = new Map<string, Promise<CollectionGraphHandle>>();

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
   * Resolve the on-disk spill (NDJSON) path the streaming pass-1 uses
   * for a given collection + run. Exposed so the codegraph provider
   * does not duplicate the layout logic and tests can assert cleanup.
   */
  spillPathFor(collectionName: string, runId: string): string {
    return join(this.spillDir, `${sanitiseCollectionName(collectionName)}-${runId}.ndjson`);
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
      // Migrations live in `infra/migration/database/migrations` and
      // ship inline as TS modules (no SQL file copy step) — same path
      // the prior shared-DB bootstrap used.
      const { runMigrations } = await import("../../infra/migration/database/runner.js");
      const { DATABASE_MIGRATIONS } = await import("../../infra/migration/database/migrations/index.js");
      await runMigrations(graphDb, DATABASE_MIGRATIONS);
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

  /** Close every cached client. Idempotent. Used at shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map(async (e) => e.graphDb.close().catch(() => undefined)));
  }
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
