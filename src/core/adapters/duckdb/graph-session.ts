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

  constructor(private readonly options: DuckDbGraphSessionOptions) {}

  async open(): Promise<void> {
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
      await this.requireConn().run(sql);
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

  async close(): Promise<void> {
    // The current @duckdb/node-api minor (~1.5.x) does not expose a
    // sync `disconnect`/`close` on the connection or instance shapes
    // we depend on — connections are released when their owning
    // instance is garbage-collected. Drop the references so tests can
    // re-open the same DB file without contention.
    this.conn = undefined;
    this.instance = undefined;
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
    await this.requireConn().run(sql);
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
    const prep = await this.requireConn().prepare(sql);
    try {
      bindParams(prep, asBindable(params));
      await prep.run();
    } finally {
      prep.destroySync();
    }
  }

  /** Generic query returning all rows as plain JSON objects. Disposes the
   * prepared statement after materialising rows (same native-leak guard as
   * `run` — see its doc comment). */
  async queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const prep = await this.requireConn().prepare(sql);
    try {
      bindParams(prep, asBindable(params));
      const reader = await prep.runAndReadAll();
      return reader.getRowObjectsJson() as T[];
    } finally {
      prep.destroySync();
    }
  }

  /**
   * Yield result rows one DuckDB chunk at a time (no whole-result
   * materialisation). `connection.stream` returns a result whose
   * `fetchChunk()` pulls the next ~2048-row vector, returning null when
   * drained. Each chunk's column arrays are read via `getRows()` and
   * released before the next fetch.
   */
  async *streamRows(sql: string): AsyncIterableIterator<DuckDBValue[]> {
    const result = await this.requireConn().stream(sql);
    let chunk = await result.fetchChunk();
    while (chunk && chunk.rowCount > 0) {
      const rows = chunk.getRows();
      for (const row of rows) {
        yield row;
      }
      chunk = await result.fetchChunk();
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
   * `mode` picks the duplicate-PK contract, and these are NOT interchangeable:
   * `"orIgnore"` is load-bearing where the same row can legitimately arrive
   * twice (a file re-importing one module); `"orReplace"` is for a node-style
   * table where the last write should win rather than the first (mirrors the
   * single-row `INSERT OR REPLACE` `writeFileRows` uses for `cg_symbols_files`);
   * `"insert"` keeps a duplicate loud for callers that clear the table first
   * and therefore treat a collision as a bug.
   */
  async insertBatched(
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
    mode: "insert" | "orIgnore" | "orReplace" = "insert",
  ): Promise<void> {
    if (rows.length === 0) return;
    const tuple = `(${columns.map(() => "?").join(", ")})`;
    const verb = mode === "orIgnore" ? "INSERT OR IGNORE" : mode === "orReplace" ? "INSERT OR REPLACE" : "INSERT";
    const prefix = `${verb} INTO ${table} (${columns.join(", ")}) VALUES `;
    for (let i = 0; i < rows.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      await this.run(prefix + chunk.map(() => tuple).join(", "), chunk.flat());
    }
  }

  /**
   * Chunk-safe `DELETE FROM <table> WHERE <column> IN (...)` — collapses N
   * per-value DELETEs into `ceil(N / EDGE_INSERT_CHUNK_ROWS)` IN-list
   * statements. Each individual per-file DELETE the bulk file-graph write
   * used to issue re-scanned/decompressed the FSST-compressed
   * `source_rel_path` column on its own; batching removes that many
   * redundant scans (bd tea-rags-mcp-wgt19 follow-up — the DELETE-then-INSERT
   * cycle on cg_symbols_edges_file/cg_symbols_edges_method dominated
   * CODEGRAPH_FORCE_RESOLVE wall clock on taxdome). `table`/`column` are
   * compile-time literals supplied by the caller — never user input.
   */
  async deleteBatched(table: string, column: string, values: readonly unknown[]): Promise<void> {
    if (values.length === 0) return;
    for (let i = 0; i < values.length; i += EDGE_INSERT_CHUNK_ROWS) {
      const chunk = values.slice(i, i + EDGE_INSERT_CHUNK_ROWS);
      const placeholders = chunk.map(() => "?").join(", ");
      await this.run(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, chunk.slice());
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

  private requireConn(): DuckDBConnection {
    if (!this.conn) throw new Error("DuckDbGraphClient: init() must be called before use");
    return this.conn;
  }
}
