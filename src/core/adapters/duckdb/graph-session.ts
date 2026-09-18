/**
 * The DuckDB connection every codegraph collaborator writes and reads through.
 *
 * One embedded, file-backed instance per collection, one connection, one write
 * queue. The session owns the four things that are genuinely shared across the
 * whole adapter and cannot be split by role: opening the file under a resource
 * ceiling, the prepared-statement lifecycle (`run` / `queryAll` / `streamRows`),
 * serialization of transactional writes onto the single connection, and the
 * batched multi-row INSERT shape.
 *
 * Everything above it — file graph, symbols, method edges, hierarchy,
 * analytics, run stats — is a role collaborator holding a reference to one
 * session. `DuckDbGraphClient` composes them behind the `GraphDbClient`
 * contract.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";

import { DuckDbStreamIncompleteError } from "./errors.js";
import { asBindable, bindParams } from "./sql-binding.js";

/**
 * Fallback memory_limit applied to every write (READ_WRITE) connection when
 * no `resources.memoryLimit` is wired. DuckDB's own default is ~80% of system
 * RAM (e.g. 14.3 GiB on an 18 GB host); leaving a write connection at that
 * default can OOM the machine natively during codegraph ingest. Mirrors the
 * `CODEGRAPH_DB_MEMORY_LIMIT` config default ("2GB") so behaviour is the same
 * whether the cap arrives via config wiring or this safety net.
 */
const DEFAULT_DB_MEMORY_LIMIT = "2GB";

/**
 * Rows per multi-row `INSERT OR IGNORE ... VALUES` statement issued by the
 * file-graph writer (bd tea-rags-mcp-f2jsb). taxdome wrote 1.58M method edges
 * through per-row prepared INSERTs at an effective ~97 rows/sec — the
 * prepare/bind/destroy round-trip per EDGE dominated, and the per-row WAL
 * churn even tripped the 2GB memory_limit inside one large transaction.
 * Batching at 200 rows measured ~48x faster (probe: 10k rows, ~1.4k/s per-row
 * vs ~66k/s batched on @duckdb/node-api 1.x).
 *
 * 200 rows x 7 params (widest table, cg_symbols_edges_method) = 1400
 * positional params per statement — verified fine with the driver's
 * positional `bindVarchar`. DuckDB's INSERT OR IGNORE keeps first-row-wins
 * semantics for duplicate-PK rows WITHIN one multi-row statement (verified
 * empirically), matching the previous sequential per-row behaviour exactly —
 * no in-JS dedupe layer is needed, and OR IGNORE stays load-bearing for
 * cross-file PK collisions (see `insertOrIgnoreBatched`).
 */
const EDGE_INSERT_CHUNK_ROWS = 200;

export interface DuckDbGraphSessionOptions {
  path: string;
  /**
   * Open mode passed through to DuckDB's `access_mode` config. Default
   * READ_WRITE. READ_ONLY allows concurrent cross-process readers — the
   * codegraph read path opens the live-version DuckDB file READ_ONLY so
   * multiple MCP processes can query while one daemon holds the RW lock.
   * A READ_ONLY connection rejects writes, so `open()` also skips the
   * resource `SET` statements (DuckDB rejects those on a RO DB).
   */
  accessMode?: "READ_WRITE" | "READ_ONLY";
  /**
   * Slice 2 resource ceiling for the embedded DuckDB instance. When
   * absent the driver picks its own defaults (≈80% of system RAM,
   * #cores threads, no spill directory) which on large repos like
   * ugnest causes the indexing pass to allocate 14GB+ and OOM.
   *
   * `memoryLimit` — DuckDB-formatted size string (`"2GB"`, `"512MB"`).
   *   Caps per-connection RAM; once hit DuckDB spills sorts/joins to
   *   `tempDirectory`.
   * `threads` — number of worker threads. Codegraph is writer-bound so
   *   2 is plenty; more inflates per-thread arena memory.
   * `tempDirectory` — absolute path the driver may use for spill
   *   files. Created lazily by the pool / client; cleaned of stale
   *   files on init so a prior crashed process does not leak GB of
   *   sort spills into the data dir.
   * `preserveInsertionOrder` — when false, DuckDB is free to reorder
   *   rows for memory wins. The codegraph schema enforces order via
   *   ORDER BY at read time so flipping this off costs nothing at the
   *   query layer.
   */
  resources?: {
    memoryLimit?: string;
    threads?: number;
    tempDirectory?: string;
    preserveInsertionOrder?: boolean;
  };
}

export class DuckDbGraphSession {
  private instance?: DuckDBInstance;
  private conn?: DuckDBConnection;
  /**
   * Serialize transactional writes. The incremental reindex path runs
   * `notifyDeletions` (→ `handleDeletedPaths` → `removeFile` BEGIN/COMMIT)
   * and `processRelativeFiles` (→ `upsertFile` BEGIN/COMMIT) in
   * `Promise.all`. DuckDB on a single shared connection rejects the
   * second BEGIN with "cannot start a transaction within a transaction".
   * Per-method `await` on the connection isn't enough — the BEGIN itself
   * needs a critical section spanning the entire transaction body. We
   * chain transactional ops onto a shared promise so callers never see
   * nested BEGINs even under aggressive Promise.all fan-out.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * Native calls awaiting the driver on `conn` right now. `close` waits for
   * zero: `closeSync` issued under a running query leaves that query's promise
   * unsettled forever (@duckdb/node-api 1.5.3, bd tea-rags-mcp-amh78).
   */
  private runningNativeCalls = 0;
  private readonly nativeCallsSettled: (() => void)[] = [];
  /** Set by `close` once queued transactional writes settled — later calls are refused. */
  private refusingCalls = false;
  /**
   * The private connections of streams still being drained (see `streamRows`).
   * `close` ends them before the instance, so none outlives it.
   */
  private readonly streamConnections = new Set<DuckDBConnection>();
  private closing?: Promise<void>;

  constructor(private readonly options: DuckDbGraphSessionOptions) {}

  async open(): Promise<void> {
    this.closing = undefined;
    this.refusingCalls = false;
    mkdirSync(dirname(this.options.path), { recursive: true });
    // @duckdb/node-api `DuckDBInstance.create(path, options)` takes a
    // string→string config map. `access_mode` controls RW vs RO; only
    // set it when explicitly requested so the driver default
    // (READ_WRITE) is preserved otherwise.
    const config: Record<string, string> = {};
    if (this.options.accessMode) config.access_mode = this.options.accessMode;
    this.instance = await DuckDBInstance.create(this.options.path, config);
    this.conn = await this.instance.connect();

    // Slice 2 — apply resource ceiling BEFORE migrations so the
    // schema bootstrap itself runs under the cap. Settings are issued
    // as separate exec() calls because DuckDB rejects compound
    // statements via PRAGMA. Each is best-effort: if the driver
    // version doesn't recognise the option name (older 1.x) we
    // swallow the error rather than break ingest — the cap is a
    // protective layer, not a correctness invariant. Production builds
    // ship the version listed in package.json so this is realistically
    // a no-op fallback for test fixtures linked against older drivers.
    //
    // The spill directory is created (idempotent mkdir) but NOT
    // purged here — the pool already owns concurrent collection
    // opens, and a per-open purge would race with an in-flight NDJSON
    // spill from another collection that shares the same `.spill`
    // directory. The pool drives stale-file cleanup at construction
    // time (one-shot, before any acquire); per-client init only
    // ensures DuckDB has a writable temp_directory to spill into.
    // A READ_ONLY connection rejects `SET` writes, so skip the resource
    // ceiling entirely on RO. The cap is a protective layer for the
    // write/ingest path; readers never mutate and inherit the daemon's
    // already-applied ceiling on the underlying file.
    const isReadOnly = this.options.accessMode === "READ_ONLY";
    const r = isReadOnly ? undefined : this.options.resources;
    if (!isReadOnly) {
      // A write (READ_WRITE) connection must NEVER be left uncapped: an
      // unconfigured connection inherits DuckDB's ~80%-of-system-RAM default
      // (14.3 GiB on an 18 GB host) and can OOM the machine natively during
      // codegraph ingest. Always apply the configured limit, or the built-in
      // conservative default when none is wired. RO connections reject SET
      // writes and inherit the file's already-applied ceiling, so skip there.
      const memoryLimit = r?.memoryLimit ?? DEFAULT_DB_MEMORY_LIMIT;
      // `execSilent` swallows a rejected SET (older drivers, bad value). Read
      // the effective limit before/after: if it is unchanged the cap did NOT
      // take and the connection is silently running at DuckDB's ~80%-of-RAM
      // default — surface that loudly instead of risking a native OOM. That
      // silent failure is exactly what hid the codegraph OOM in the field.
      const beforeLimit = await this.readMemoryLimit();
      await this.execSilent(`SET memory_limit = '${memoryLimit.replace(/'/g, "''")}'`);
      const afterLimit = await this.readMemoryLimit();
      if (beforeLimit !== undefined && afterLimit === beforeLimit) {
        console.error(
          `[DuckDbGraphClient] memory_limit cap '${memoryLimit}' did NOT take effect ` +
            `(still '${afterLimit}') — connection running at DuckDB's default ` +
            `(~80% of system RAM); native OOM risk. db=${this.options.path}`,
        );
      }
      if (r) {
        const spillDir = r.tempDirectory;
        if (spillDir) {
          try {
            mkdirSync(spillDir, { recursive: true });
          } catch {
            // Directory may already exist (concurrent first-callers from
            // the pool). The SET below is the load-bearing step.
          }
          await this.execSilent(`SET temp_directory = '${spillDir.replace(/'/g, "''")}'`);
        }
        if (r.threads !== undefined && r.threads > 0) {
          await this.execSilent(`SET threads = ${Math.floor(r.threads)}`);
        }
        if (r.preserveInsertionOrder === false) {
          await this.execSilent(`SET preserve_insertion_order = false`);
        }
      }
    }
  }

  /**
   * Issue a SET / PRAGMA-style statement that we WANT to apply but can
   * tolerate a driver-version error on. Used by `open()` for resource
   * ceilings — settings are advisory, not invariants.
   */
  private async execSilent(sql: string): Promise<void> {
    try {
      await this.exec(sql);
    } catch {
      // Older driver versions reject unrecognised setting names; allow
      // the ingest path to continue without the cap.
    }
  }

  /**
   * Read the effective DuckDB `memory_limit` (e.g. "1.8 GiB"). Returns
   * `undefined` if the setting can't be read — used by `open()` to verify the
   * resource-ceiling SET actually took effect (see the OOM guard there).
   */
  private async readMemoryLimit(): Promise<string | undefined> {
    try {
      const rows = await this.queryAll<{ m: string }>("SELECT current_setting('memory_limit') AS m");
      return rows[0]?.m;
    } catch {
      return undefined;
    }
  }

  /**
   * Close the connection and the database instance for real (bd
   * tea-rags-mcp-amh78). It used to drop its references and leave the instance
   * to the garbage collector, which closed it — WAL handling and file lock
   * included — at a moment nobody chose. Now:
   *
   * - It WAITS for queued transactional writes and for every native call still
   *   running, then refuses new ones. Closing under a running query leaves that
   *   query unsettled forever, so a daemon op racing a close would hang its
   *   client.
   * - It does NOT checkpoint. After a checkpoint DuckDB deletes `<path>.wal` BY
   *   PATH, and a client the pool retires as stale no longer owns that path: a
   *   different database may keep its WAL there (measured: a clone's WAL, and
   *   every row in it, gone). Changes since the last explicit `checkpoint()`
   *   stay in the WAL and replay on the next open — what a dropped reference
   *   left on disk too.
   * - It releases the file lock now, not whenever the instance is finalized.
   *
   * Idempotent; concurrent callers share one close.
   */
  async close(): Promise<void> {
    this.closing ??= this.closeNative();
    return this.closing;
  }

  private async closeNative(): Promise<void> {
    await this.writeQueue;
    this.refusingCalls = true;
    if (this.runningNativeCalls > 0) {
      await new Promise<void>((resolve) => {
        this.nativeCallsSettled.push(resolve);
      });
    }
    // A stream suspended between chunks holds no native call, so it does not
    // keep the close open; its connection goes here, and its next fetch
    // throws `DuckDbStreamIncompleteError` instead of ending quietly.
    for (const streamConn of this.streamConnections) streamConn.closeSync();
    this.streamConnections.clear();
    const { conn, instance } = this;
    this.conn = undefined;
    this.instance = undefined;
    try {
      if (conn && this.options.accessMode !== "READ_ONLY") {
        await conn.run("PRAGMA disable_checkpoint_on_shutdown");
      }
    } finally {
      conn?.closeSync();
      instance?.closeSync();
    }
  }

  /**
   * Run one native call on the connection, counted so `close` can wait it out.
   * Counted per driver await, never across a `yield`, so an iterator abandoned
   * mid-stream cannot hold a close open.
   */
  private async onConnection<T>(call: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const conn = this.requireConn();
    this.runningNativeCalls += 1;
    try {
      return await call(conn);
    } finally {
      this.settleNativeCall();
    }
  }

  /**
   * Serialize a write through the queue. The wrapped op runs only after
   * the previous queued op settled — successfully OR with an error. We
   * intentionally swallow upstream errors at the queue level (failures
   * are rethrown to the original caller via the returned promise) so
   * one failed write never blocks subsequent writes from starting.
   */
  async serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op, op);
    // Track the next slot without surfacing errors to the chain head.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Run `body` inside one serialized `BEGIN` / `COMMIT`, rolling back and
   * rethrowing on any failure — the shape every transactional write in this
   * adapter uses. Going through {@link serialize} is what keeps a second BEGIN
   * from landing on the shared connection while this one is open.
   */
  async transaction<T>(body: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.exec("BEGIN");
      try {
        const result = await body();
        await this.exec("COMMIT");
        return result;
      } catch (err) {
        await this.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /**
   * Flush the WAL to the main database file. Issued periodically by
   * the slice 2 streaming pass-2 so a long-running indexing pass does
   * not accumulate an unbounded write-ahead log (the WAL grows in JS
   * heap-resident buffers and is the proximate cause of the pre-fix
   * OOM seen on ugnest). Wrapped in the same write queue as the
   * upsert path so a CHECKPOINT cannot interleave with a half-open
   * BEGIN/COMMIT.
   */
  async checkpoint(): Promise<void> {
    return this.serialize(async () => this.exec("CHECKPOINT"));
  }

  /** Generic exec — used by the migration runner. Returns no rows. */
  async exec(sql: string): Promise<void> {
    await this.onConnection(async (conn) => {
      await conn.run(sql);
    });
  }

  /**
   * Generic prepared exec with positional params.
   *
   * `destroySync()` in `finally` is load-bearing, not hygiene: @duckdb/node-api
   * prepared statements hold NATIVE resources that V8's GC does not account for
   * (the native size is invisible to heap heuristics, so finalizers fire too
   * late or never under churn). pass-2 issues millions of per-edge INSERTs
   * through `run`; undisposed statements ballooned the indexer to 32 GB on a
   * large repo. Always dispose the statement we created.
   */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.onConnection(async (conn) => {
      const prep = await conn.prepare(sql);
      try {
        bindParams(prep, asBindable(params));
        await prep.run();
      } finally {
        prep.destroySync();
      }
    });
  }

  /** Generic query returning all rows as plain JSON objects. Disposes the
   * prepared statement after materialising rows (same native-leak guard as
   * `run` — see its doc comment). */
  async queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.onConnection(async (conn) => {
      const prep = await conn.prepare(sql);
      try {
        bindParams(prep, asBindable(params));
        const reader = await prep.runAndReadAll();
        return reader.getRowObjectsJson() as T[];
      } finally {
        prep.destroySync();
      }
    });
  }

  /**
   * Yield result rows one DuckDB chunk at a time (no whole-result
   * materialisation), all of them or an error (bd tea-rags-mcp-sgo8v).
   *
   * A DuckDB streaming result is invalidated by any other statement on its
   * connection, and its `fetchChunk` then answers `null` — the answer it gives
   * at the true end; the driver exposes no error for it. On the shared
   * connection every concurrent caller (in the daemon: every client of the
   * collection) could cut a drain short without a trace — probed, 3000 rows
   * alone, 2048 beside one concurrent read. So a stream runs on a connection of
   * its OWN, inside a read transaction whose snapshot a closing `count(*)`
   * checks the drain against: a short drain throws `DuckDbStreamIncompleteError`
   * instead of returning. A session close while the stream is still being
   * drained throws the same, never a quiet end.
   *
   * The connection is released on every exit, including a consumer that stops
   * iterating early.
   */
  async *streamRows(sql: string): AsyncIterableIterator<DuckDBValue[]> {
    const conn = await this.openStreamConnection();
    let yielded = 0;
    try {
      // One snapshot for the stream AND its count, whatever commits meanwhile.
      await this.onStreamConnection(conn, yielded, async (c) => c.run("BEGIN TRANSACTION"));
      const result = await this.onStreamConnection(conn, yielded, async (c) => c.stream(sql));
      for (;;) {
        const chunk = await this.onStreamConnection(conn, yielded, async () => result.fetchChunk());
        if (!chunk || chunk.rowCount === 0) break;
        for (const row of chunk.getRows()) {
          yielded += 1;
          yield row;
        }
      }
      // Only after the drain: a count issued mid-stream would itself end it.
      const expected = await this.onStreamConnection(conn, yielded, async (c) => {
        const reader = await c.runAndReadAll(`SELECT count(*) AS n FROM (${sql}) AS streamed`);
        return Number(reader.getRowObjects()[0]?.n ?? 0);
      });
      if (yielded !== expected) {
        throw new DuckDbStreamIncompleteError(this.options.path, { reason: "truncated", yielded, expected });
      }
      await this.onStreamConnection(conn, yielded, async (c) => c.run("COMMIT"));
    } finally {
      // Disconnecting ends the read transaction if the drain never reached COMMIT.
      if (this.streamConnections.delete(conn)) conn.closeSync();
    }
  }

  /** A fresh connection on this session's instance, tracked so `close` can end it. */
  private async openStreamConnection(): Promise<DuckDBConnection> {
    this.requireConn();
    const { instance } = this;
    if (!instance) throw new Error("DuckDbGraphClient: init() must be called before use");
    this.runningNativeCalls += 1;
    try {
      const conn = await instance.connect();
      this.streamConnections.add(conn);
      return conn;
    } finally {
      this.settleNativeCall();
    }
  }

  /**
   * One native call on a stream's own connection, counted like `onConnection`
   * so `close` waits it out. A stream whose connection the session already
   * closed is INCOMPLETE, and says so — it must not read as a finished one.
   */
  private async onStreamConnection<T>(
    conn: DuckDBConnection,
    yielded: number,
    call: (conn: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    if (this.refusingCalls || !this.streamConnections.has(conn)) {
      throw new DuckDbStreamIncompleteError(this.options.path, { reason: "closed", yielded });
    }
    this.runningNativeCalls += 1;
    try {
      return await call(conn);
    } finally {
      this.settleNativeCall();
    }
  }

  private settleNativeCall(): void {
    this.runningNativeCalls -= 1;
    if (this.runningNativeCalls === 0) {
      for (const resolve of this.nativeCallsSettled.splice(0)) resolve();
    }
  }

  /**
   * Issue `INSERT OR IGNORE INTO <table> (<cols>) VALUES (…), (…), …` in
   * chunks of `EDGE_INSERT_CHUNK_ROWS` (bd tea-rags-mcp-f2jsb). Replaces the
   * per-row INSERT loops in the file-graph write path — one prepared statement
   * per ~200 rows instead of one per row (see the constant's doc for measured
   * rates). Callers run inside the per-file transaction; a chunk failure
   * rolls the whole file back, same as the per-row path.
   *
   * OR IGNORE stays load-bearing even with batching: PK collisions can come
   * from rows already persisted by ANOTHER file's upsert (e.g. a
   * monkey-patched symbol defined in two files emits the same
   * (source, call, target) tuple from both) — in-JS dedupe alone cannot see
   * those. Duplicate-PK rows WITHIN one statement are also first-row-wins
   * under DuckDB's OR IGNORE, preserving the old sequential semantics.
   *
   * `table`/`columns` are compile-time literals supplied by the caller
   * — never user input; all VALUES go through positional binds.
   */
  async insertOrIgnoreBatched(
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    return this.insertBatched(table, columns, rows, "orIgnore");
  }

  /**
   * Multi-row `INSERT` in chunks of {@link EDGE_INSERT_CHUNK_ROWS} — the shared
   * write shape behind every bulk path here (~48x the per-row prepared INSERT,
   * see that constant's docblock for the measurement).
   *
   * `mode` picks the duplicate-PK contract, and the two are NOT
   * interchangeable: `"orIgnore"` is load-bearing where the same row can
   * legitimately arrive twice (a file re-importing one module); `"insert"`
   * keeps a duplicate loud for callers that clear the table first and
   * therefore treat a collision as a bug.
   *
   * There is deliberately no `INSERT OR REPLACE` mode. DuckDB implements it as
   * a delete plus an insert of the same key, which is the shape that turns a
   * failed commit into a native abort — see {@link applyScopedRowDiff} for the
   * mechanism and the crash it caused.
   */
  async insertBatched(
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
    mode: "insert" | "orIgnore" = "insert",
  ): Promise<void> {
    if (rows.length === 0) return;
    const tuple = `(${columns.map(() => "?").join(", ")})`;
    const verb = mode === "orIgnore" ? "INSERT OR IGNORE" : "INSERT";
    const prefix = `${verb} INTO ${table} (${columns.join(", ")}) VALUES `;
    for (let i = 0; i < rows.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      await this.run(prefix + chunk.map(() => tuple).join(", "), chunk.flat());
    }
  }

  /**
   * Chunk-safe join UPDATE: `UPDATE <table> SET <set> FROM (VALUES …) AS v(…)`
   * matched on `<key>` — the update-side twin of {@link insertBatched}, in the
   * same {@link EDGE_INSERT_CHUNK_ROWS} chunks. Collapses N per-row prepared
   * UPDATEs into `ceil(N / chunk)` statements, which is what takes the deferred
   * chunk pass's symbol→chunk join off the per-file round-trip path (bd
   * tea-rags-mcp-6aytq).
   *
   * Each row supplies the key columns first, then the set columns, in the
   * declared order. Rows matching no target row update nothing — the same
   * silent no-op the per-row form has. A row appearing twice for the same key
   * is the caller's to resolve BEFORE calling: DuckDB does not define which of
   * two colliding VALUES rows wins.
   *
   * `table`/`keyColumns`/`setColumns` are compile-time literals supplied by the
   * caller — never user input; all VALUES go through positional binds.
   */
  async updateFromRows(
    table: string,
    keyColumns: readonly string[],
    setColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const columns = [...keyColumns, ...setColumns];
    const tuple = `(${columns.map(() => "?").join(", ")})`;
    const assignments = setColumns.map((c) => `${c} = v.${c}`).join(", ");
    const match = keyColumns.map((c) => `${table}.${c} = v.${c}`).join(" AND ");
    for (let i = 0; i < rows.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      await this.run(
        `UPDATE ${table} SET ${assignments} FROM (VALUES ${chunk.map(() => tuple).join(", ")}) ` +
          `AS v(${columns.join(", ")}) WHERE ${match}`,
        chunk.flat(),
      );
    }
  }

  /**
   * Make `table`'s rows for one SCOPE equal `rows`, WITHOUT ever deleting and
   * re-inserting the same primary key inside the caller's transaction
   * (bd tea-rags-mcp-8l8d3).
   *
   * The naive form of that intent — `DELETE WHERE scope IN (...)` followed by a
   * re-INSERT of the whole set — is what this replaces, and it is not merely
   * wasteful. DuckDB's commit path is not exception-safe for a transaction
   * whose delete set and insert set share a key: when the commit fails for ANY
   * reason, `UndoBuffer::RevertCommit` restores the deleted rows into the
   * indexes, and that re-append lands on the key the same transaction just
   * inserted, raising
   * `INTERNAL Error: Failed to append to PRIMARY_<table>_N: ... duplicate key`
   * from a native context — `libc++abi: terminating`, an abort() that no
   * JavaScript handler can catch. It killed the codegraph daemon nine times on
   * 2026-08-17 (taxdome, `--force-enrichments codegraph`), and that daemon
   * serves every collection on the machine.
   *
   * So the write is expressed as a DIFF instead:
   *
   * - key in scope on disk, absent from `rows`  -> DELETE by key
   * - key in `rows`, absent on disk             -> INSERT OR IGNORE
   * - key on both sides, value columns differ   -> UPDATE in place
   * - key on both sides, value columns equal    -> not touched at all
   *
   * No key is ever on both the delete side and the insert side. The UPDATE
   * branch preserves the previous semantics (a re-walk refreshes non-key
   * columns) and fires only when a value genuinely changed, so it does not
   * reintroduce the churn. It is also strictly less work than the old shape: on
   * a re-index most edges are unchanged, and an unchanged edge now costs one
   * read instead of a delete plus an insert.
   *
   * `rows` are ordered `[...keyColumns, ...valueColumns]`. Duplicate keys
   * within `rows` are first-wins, matching `INSERT OR IGNORE`. `scopeColumn`
   * need not be part of the key: a key owned by a row OUTSIDE this scope is
   * invisible to the scope read, so it falls to `INSERT OR IGNORE` and is
   * ignored — the same first-wins outcome the previous writer produced.
   * `table` and the column names are compile-time literals supplied by the
   * caller, never user input; every value goes through a positional bind.
   */
  async applyScopedRowDiff(
    table: string,
    scopeColumn: string,
    scopeValues: readonly unknown[],
    keyColumns: readonly string[],
    valueColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (scopeValues.length === 0) return;
    const columns = [...keyColumns, ...valueColumns];
    const keyWidth = keyColumns.length;

    const existing = new Map<string, { key: unknown[]; values: string }>();
    for (let i = 0; i < scopeValues.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = scopeValues.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      const found = await this.queryAll<Record<string, unknown>>(
        `SELECT ${columns.join(", ")} FROM ${table} WHERE ${scopeColumn} IN (${chunk.map(() => "?").join(", ")})`,
        chunk.slice(),
      );
      for (const row of found) {
        const tuple = columns.map((c) => row[c]);
        const key = tuple.slice(0, keyWidth);
        existing.set(tupleFingerprint(key), { key, values: tupleFingerprint(tuple.slice(keyWidth)) });
      }
    }

    const incoming = new Map<string, readonly unknown[]>();
    for (const row of rows) {
      const key = tupleFingerprint(row.slice(0, keyWidth));
      if (!incoming.has(key)) incoming.set(key, row);
    }

    const toInsert: (readonly unknown[])[] = [];
    const toUpdate: (readonly unknown[])[] = [];
    for (const [key, row] of incoming) {
      const current = existing.get(key);
      if (current === undefined) toInsert.push(row);
      else if (valueColumns.length > 0 && current.values !== tupleFingerprint(row.slice(keyWidth))) toUpdate.push(row);
    }
    const toDelete: unknown[][] = [];
    for (const [key, row] of existing) {
      if (!incoming.has(key)) toDelete.push(row.key);
    }

    await this.deleteByKeyBatched(table, keyColumns, toDelete);
    await this.insertOrIgnoreBatched(table, columns, toInsert);
    await this.updateFromRows(table, keyColumns, valueColumns, toUpdate);
  }

  /**
   * `UPDATE <table> SET <column> = NULL WHERE <scopeColumn> IN (?, ?, …)` in
   * {@link EDGE_INSERT_CHUNK_ROWS} chunks — the reset half of a column whose
   * writer owns it wholesale for the rows in scope (bd tea-rags-mcp-tslvq:
   * `cg_symbols.chunk_id`, cleared for every file the deferred chunk pass names
   * before the fresh join is applied).
   *
   * One statement per chunk rather than one per value, because none of these
   * tables carries a secondary index on the filtered column any more — migration
   * 019 dropped them all off `cg_symbols` — so a per-value loop pays its OWN
   * sequential scan of the whole table each iteration.
   *
   * The `IS NOT NULL` guard is what makes this cheap on the common path: a row
   * already clear is not rewritten, so a cold index (every chunk_id NULL) costs
   * a scan and no row versions at all.
   *
   * Chunking is safe for the same reason it is safe in
   * {@link deleteByKeyBatched}: the predicate is an explicit list of values, so
   * splitting it cannot make one chunk skip a row a later chunk would clear. A
   * scope predicate written as a RANGE or a LIKE could not be split this way.
   */
  async clearColumnByScopeValuesBatched(
    table: string,
    column: string,
    scopeColumn: string,
    scopeValues: readonly unknown[],
  ): Promise<void> {
    if (scopeValues.length === 0) return;
    for (let i = 0; i < scopeValues.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = scopeValues.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      await this.run(
        `UPDATE ${table} SET ${column} = NULL WHERE ${scopeColumn} IN (${chunk.map(() => "?").join(", ")}) ` +
          `AND ${column} IS NOT NULL`,
        chunk,
      );
    }
  }

  /**
   * `DELETE FROM <table> WHERE (k1, k2, ...) IN (VALUES (?, ?), ...)` in
   * {@link EDGE_INSERT_CHUNK_ROWS} chunks. Chunking is safe because each chunk
   * names the exact rows it removes — unlike a scope DELETE, whose predicate
   * cannot be split without a chunk removing rows a later chunk would keep.
   *
   * A NULL key column cannot occur: DuckDB requires every PRIMARY KEY column to
   * be NOT NULL, so the `IN (VALUES ...)` comparison never meets the SQL NULL
   * semantics that would silently match nothing.
   */
  private async deleteByKeyBatched(
    table: string,
    keyColumns: readonly string[],
    keys: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const tuple = `(${keyColumns.map(() => "?").join(", ")})`;
    const prefix = `DELETE FROM ${table} WHERE (${keyColumns.join(", ")}) IN (VALUES `;
    for (let i = 0; i < keys.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = keys.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      await this.run(`${prefix}${chunk.map(() => tuple).join(", ")})`, chunk.flat());
    }
  }

  private requireConn(): DuckDBConnection {
    if (this.refusingCalls) throw new Error("DuckDbGraphClient: used after close()");
    if (!this.conn) throw new Error("DuckDbGraphClient: init() must be called before use");
    return this.conn;
  }
}

/**
 * Collapse a row tuple into one comparable string, for
 * {@link DuckDbGraphSession#applyScopedRowDiff}.
 *
 * Two jobs, both load-bearing. It normalises across the driver boundary —
 * DuckDB hands BIGINT back as a string and DOUBLE as a number, so comparing raw
 * driver output against the caller's own JS values would report unchanged rows
 * as changed, and a spurious UPDATE is exactly the index churn the diff exists
 * to avoid. And it stays injective: every part is length-prefixed, so no choice
 * of separator can make `["ab", "c"]` and `["a", "bc"]` collide, and NULL gets
 * its own marker that no length-prefixed value can imitate.
 */
function tupleFingerprint(parts: readonly unknown[]): string {
  return parts.map(fingerprintCell).join("|");
}

/** One column's contribution to {@link tupleFingerprint}. */
function fingerprintCell(value: unknown): string {
  if (value === null || value === undefined) return "~";
  // Every column these keys address is a DuckDB scalar, so the primitive
  // branch is the real one. An object would be a driver surprise: serialise it
  // rather than let it stringify to `[object Object]` and compare equal to
  // every other object.
  const text = typeof value === "object" ? JSON.stringify(value) : String(value as string | number | boolean | bigint);
  return `${text.length}:${text}`;
}
