/**
 * DuckDB implementation of the codegraph `GraphDbClient` contract.
 *
 * Slice 1 uses an embedded, file-backed DuckDB instance per collection,
 * routed by `GraphDbClientPool` to `<dataDir>/codegraph/<collection>.duckdb`.
 * Slice 4 adds
 * `PostgresGraphClient` behind the same interface — this client owns
 * driver-specific concerns (prepared-statement reuse, BEGIN/COMMIT, value
 * binding) and the contract owns the SQL-agnostic shape.
 *
 * Concurrency: methods run sequentially on a single shared connection;
 * `upsertFile` wraps its DELETE+INSERT pass in a transaction. The
 * `MigrationCapableClient` adapter surface (`exec` / `run` / `queryAll`)
 * is also exposed for the migration runner.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import picomatch from "picomatch";

import type {
  AmbiguousCallerSite,
  AritySignature,
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
  KwargSignature,
  MethodEdgeKind,
  RelPath,
  ResolveRunStatsRow,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../contracts/types/codegraph.js";

// Graph algorithms (Tarjan SCC, PageRank) intentionally NOT imported
// here. Per the layering rules in .claude/rules/domain-boundaries.md
// adapters/ may not import from domains/. Cycle/PageRank computation
// lives in domains/trajectory/codegraph/infra/ and the adapter only
// exposes the primitives (listAdjacency, replaceCycles, replacePageRanks)
// the domain orchestrator drives.

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
 * Rows per multi-row `INSERT OR IGNORE ... VALUES` statement issued by
 * `upsertFileImpl` (bd tea-rags-mcp-f2jsb). taxdome wrote 1.58M method edges
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

/**
 * The `cg_symbols` columns that carry a {@link SymbolDefinition} — the single
 * source of truth for BOTH write paths (per-file `upsertSymbols` and batched
 * `upsertSymbolsBulk`) and the hydration SELECT. Order matches
 * {@link toCgSymbolsRow}'s tuple; a new definition field means editing this
 * list, that projection and {@link fromCgSymbolsRow} — the three places the
 * compiler and the round-trip tests hold together.
 *
 * `chunk_id` is deliberately absent: it is not part of a definition, it is
 * backfilled after chunking by `updateSymbolChunkIds`.
 *
 * Column names are compile-time literals, never user input; every VALUE goes
 * through a positional bind.
 */
const CG_SYMBOLS_DEF_COLUMNS = [
  "rel_path",
  "symbol_id",
  "fq_name",
  "short_name",
  "scope_json",
  "arity_json",
  "visibility",
  "kwargs_json",
  "accepts_block",
  "is_abstract_stub",
] as const;

const CG_SYMBOLS_DEF_INSERT_SQL = `INSERT OR IGNORE INTO cg_symbols (${CG_SYMBOLS_DEF_COLUMNS.join(", ")}) VALUES (${CG_SYMBOLS_DEF_COLUMNS.map(
  () => "?",
).join(", ")})`;

/** Raw `cg_symbols` row as read back by {@link DuckDbGraphClient.listAllSymbols}. */
interface CgSymbolsRow {
  rel_path: string;
  symbol_id: string;
  fq_name: string;
  short_name: string;
  scope_json: string;
  arity_json: string | null;
  visibility: string | null;
  kwargs_json: string | null;
  accepts_block: boolean | null;
  /** NULL on a row written before migration 016 — read as "not a stub". */
  is_abstract_stub: boolean | null;
}

/**
 * Project a definition onto the `cg_symbols` tuple — the ONE write-direction
 * mapping point, shared by the per-file and the batched writer so a new field
 * cannot land on one path and silently miss the other (which is exactly how
 * `isAbstractStub` shipped unpersisted, bd tea-rags-mcp-eikry).
 */
function toCgSymbolsRow(def: SymbolDefinition): unknown[] {
  return [
    def.relPath,
    def.symbolId,
    def.fqName,
    def.shortName,
    JSON.stringify(def.scope ?? []),
    def.arity ? JSON.stringify(def.arity) : null,
    def.visibility ?? null,
    def.kwargs ? JSON.stringify(def.kwargs) : null,
    def.acceptsBlock ?? null,
    def.isAbstractStub === true,
  ];
}

/**
 * Rebuild a definition from its persisted row — the ONE read-direction mapping
 * point (the symbol-table hydration seam every incremental run goes through).
 * Optional fields stay ABSENT rather than explicitly undefined, so a hydrated
 * def is shape-identical to a freshly walked one.
 */
function fromCgSymbolsRow(row: CgSymbolsRow): SymbolDefinition {
  return {
    relPath: row.rel_path,
    symbolId: row.symbol_id,
    fqName: row.fq_name,
    shortName: row.short_name,
    scope: parseScope(row.scope_json),
    ...(row.arity_json ? { arity: JSON.parse(row.arity_json) as AritySignature } : {}),
    ...(row.visibility ? { visibility: row.visibility as SymbolDefinition["visibility"] } : {}),
    ...(row.kwargs_json ? { kwargs: JSON.parse(row.kwargs_json) as KwargSignature } : {}),
    ...(row.accepts_block !== null && row.accepts_block !== undefined ? { acceptsBlock: row.accepts_block } : {}),
    // Only-ever-true, like the walker's mark: an explicit TRUE marks a stub,
    // and FALSE / NULL (pre-016 row) both mean "not a stub".
    ...(row.is_abstract_stub === true ? { isAbstractStub: true } : {}),
  };
}

export interface DuckDbGraphClientOptions {
  path: string;
  /**
   * Open mode passed through to DuckDB's `access_mode` config. Default
   * READ_WRITE. READ_ONLY allows concurrent cross-process readers — the
   * codegraph read path opens the live-version DuckDB file READ_ONLY so
   * multiple MCP processes can query while one daemon holds the RW lock.
   * A READ_ONLY connection rejects writes, so `init()` also skips the
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

export class DuckDbGraphClient implements GraphDbClient {
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

  constructor(private readonly options: DuckDbGraphClientOptions) {}

  async init(): Promise<void> {
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
   * tolerate a driver-version error on. Used by `init()` for resource
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
   * `undefined` if the setting can't be read — used by `init()` to verify the
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
   * Serialize a write through the queue. The wrapped op runs only after
   * the previous queued op settled — successfully OR with an error. We
   * intentionally swallow upstream errors at the queue level (failures
   * are rethrown to the original caller via the returned promise) so
   * one failed write never blocks subsequent writes from starting.
   */
  private async serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op, op);
    // Track the next slot without surfacing errors to the chain head.
    this.writeQueue = next.catch(() => undefined);
    return next;
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

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.serialize(async () => this.upsertFileImpl(node, edges));
  }

  private async upsertFileImpl(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.exec("BEGIN");
    try {
      await this.upsertFileRows(node, edges);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Bulk variant of `upsertFile` (mirrors `upsertSymbolsBulk`): fold M files'
   * node + edge writes into ONE `BEGIN/COMMIT` instead of M per-file
   * transactions — and, on the daemon path, ONE IPC round-trip instead of M.
   * Each file keeps its own per-`source_rel_path` DELETE+INSERT (last-wins) via
   * the shared `upsertFileRows` body, so the persisted edge / inheritance /
   * ambiguous-fanout set is byte-identical to calling `upsertFile` per file —
   * only the transaction + round-trip count drops. Any row failure rolls the
   * whole batch back (callers cap batch size + skip pathological files upstream).
   */
  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.serialize(async () => {
      await this.exec("BEGIN");
      try {
        for (const { node, edges } of entries) await this.upsertFileRows(node, edges);
        await this.exec("COMMIT");
      } catch (err) {
        await this.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /**
   * The per-file node + edge + inheritance + ambiguous-fanout write body — the
   * DELETE+INSERT lifecycle scoped by `source_rel_path`, WITHOUT the surrounding
   * transaction. Shared by `upsertFileImpl` (one BEGIN/COMMIT per file) and
   * `upsertFilesBulk` (one BEGIN/COMMIT per M files) so both persist identical rows.
   */
  private async upsertFileRows(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.run("INSERT OR REPLACE INTO cg_symbols_files (rel_path, language, content_hash) VALUES (?, ?, ?)", [
      node.relPath,
      node.language,
      node.contentHash ?? null,
    ]);
    await this.run("DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ?", [node.relPath]);
    await this.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?", [node.relPath]);
    // INSERT OR IGNORE: dedupe (source, target) — a file may
    // re-import the same module on different lines, producing the
    // same edge twice in one extraction batch.
    await this.insertOrIgnoreBatched(
      "cg_symbols_edges_file",
      ["source_rel_path", "target_rel_path", "import_text"],
      edges.fileEdges.map((e) => [node.relPath, e.targetRelPath, e.importText]),
    );
    // GraphEdges.methodEdges allows targetSymbolId=null (the
    // resolver case where an import resolves to a file but the
    // called member isn't in that file's exported symbol table).
    // The cg_symbols_edges_method PK includes target_symbol_id —
    // DuckDB enforces NOT NULL on PK columns, so we must skip
    // null-target edges at the boundary, BEFORE batching. File-level
    // reach is already captured by fileEdges; the method graph only
    // carries edges with a known target symbol.
    //
    // INSERT OR IGNORE: same call shape may repeat — e.g.
    // `this.cache.get(x)` invoked from multiple branches of the
    // same method body. collectCalls walks every call_expression
    // and emits one CallRef per occurrence; the PK
    // (source_symbol_id, call_expression, target_symbol_id) is
    // edge-existence semantics, not occurrence count.
    // edge_kind/confidence (bd 2jet) default to exact/1.0 when the
    // resolver did not mark the edge as CHA fan-out. INSERT OR IGNORE
    // keeps the first edge's provenance when the same (source, call,
    // target) tuple repeats — edge-existence semantics, not occurrence.
    await this.insertOrIgnoreBatched(
      "cg_symbols_edges_method",
      [
        "source_symbol_id",
        "source_rel_path",
        "target_symbol_id",
        "target_rel_path",
        "call_expression",
        "edge_kind",
        "confidence",
      ],
      edges.methodEdges
        .filter((e) => e.targetSymbolId !== null)
        .map((e) => [
          e.sourceSymbolId,
          node.relPath,
          e.targetSymbolId,
          e.targetRelPath,
          e.callExpression,
          e.edgeKind ?? "exact",
          e.confidence ?? 1.0,
        ]),
    );
    // Inheritance edges (bd tea-rags-mcp-f10y). Per-source-file delete+insert,
    // same lifecycle as the edge tables: re-walking a file replaces its rows.
    // INSERT OR IGNORE dedupes a (source, ancestor, kind) declared twice in
    // one extraction (e.g. duplicate include).
    await this.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [node.relPath]);
    await this.insertOrIgnoreBatched(
      "cg_symbols_inheritance",
      [
        "source_fq_name",
        "source_rel_path",
        "source_symbol_id",
        "ancestor_fq_name",
        "ancestor_symbol_id",
        "kind",
        "ordinal",
      ],
      (edges.inheritance ?? []).map((e) => [
        e.sourceFqName,
        node.relPath,
        e.sourceSymbolId,
        e.ancestorFqName,
        e.ancestorSymbolId,
        e.kind,
        e.ordinal,
      ]),
    );
    // Ambiguous fan-out aggregates (bd tea-rags-mcp-f2jsb / j0pki). Same
    // per-source-file DELETE+INSERT lifecycle as the edge tables: re-walking
    // a file replaces its rows (a fan-out resolved away must not survive).
    // INSERT OR IGNORE dedupes a repeated (source, call_expression) shape —
    // aggregate-existence semantics, not occurrence count.
    await this.run("DELETE FROM cg_ambiguous_fanout WHERE source_rel_path = ?", [node.relPath]);
    await this.insertOrIgnoreBatched(
      "cg_ambiguous_fanout",
      ["source_symbol_id", "source_rel_path", "call_expression", "member", "candidate_count"],
      (edges.ambiguousFanouts ?? []).map((a) => [
        a.sourceSymbolId,
        node.relPath,
        a.callExpression,
        a.member,
        a.candidateCount,
      ]),
    );
  }

  /**
   * Issue `INSERT OR IGNORE INTO <table> (<cols>) VALUES (…), (…), …` in
   * chunks of `EDGE_INSERT_CHUNK_ROWS` (bd tea-rags-mcp-f2jsb). Replaces the
   * per-row INSERT loops in `upsertFileImpl` — one prepared statement per
   * ~200 rows instead of one per row (see the constant's doc for measured
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
   * `table`/`columns` are compile-time literals supplied by `upsertFileImpl`
   * — never user input; all VALUES go through positional binds.
   */
  private async insertOrIgnoreBatched(
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
   * `mode` picks the duplicate-PK contract, and the two are NOT interchangeable:
   * `"orIgnore"` is load-bearing where the same row can legitimately arrive
   * twice (a file re-importing one module), while `"insert"` keeps a duplicate
   * loud for callers that clear the table first and therefore treat a collision
   * as a bug.
   */
  private async insertBatched(
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

  async removeFile(relPath: RelPath): Promise<void> {
    return this.serialize(async () => this.removeFileImpl(relPath));
  }

  private async removeFileImpl(relPath: RelPath): Promise<void> {
    // DuckDB rejects ON DELETE CASCADE; emulate manually. Order matters —
    // delete every edge that references this rel_path (as source OR
    // target), then delete the file row itself. Wrapped in a transaction
    // so a partial failure leaves the DB consistent.
    await this.exec("BEGIN");
    try {
      await this.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ? OR target_rel_path = ?", [
        relPath,
        relPath,
      ]);
      await this.run("DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ? OR target_rel_path = ?", [
        relPath,
        relPath,
      ]);
      await this.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [relPath]);
      await this.run("DELETE FROM cg_ambiguous_fanout WHERE source_rel_path = ?", [relPath]);
      await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      await this.run("DELETE FROM cg_symbols_files WHERE rel_path = ?", [relPath]);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    return this.serialize(async () => this.upsertSymbolsImpl(relPath, definitions));
  }

  private async upsertSymbolsImpl(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    // DELETE+INSERT inside a transaction so a partial failure leaves
    // either the full new set or the previous set — never a mix. Empty
    // definitions list clears the file (idempotent with handleDeletedPaths).
    //
    // INSERT OR IGNORE because the walker can legitimately emit the same
    // symbolId twice for one file: TypeScript get/set accessor pairs,
    // function overload signatures sharing a name, and other language
    // patterns where multiple AST nodes contribute to the same logical
    // identifier. The PK (rel_path, symbol_id) is identity, not
    // occurrence count — first row wins.
    await this.exec("BEGIN");
    try {
      await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      for (const def of definitions) {
        await this.run(CG_SYMBOLS_DEF_INSERT_SQL, toCgSymbolsRow(def));
      }
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Batched form of {@link upsertSymbols}: one transaction for many files
   * instead of one BEGIN/COMMIT per file. Equivalent to calling
   * `upsertSymbols(relPath, definitions)` once per entry, in order — so a
   * later entry for the same relPath fully REPLACES an earlier one (last-wins
   * per relPath, matching sequential DELETE+INSERT). Empty `entries` is a
   * no-op.
   */
  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.serialize(async () => this.upsertSymbolsBulkImpl(entries));
  }

  private async upsertSymbolsBulkImpl(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    // Same DELETE+INSERT-inside-a-transaction contract as upsertSymbolsImpl,
    // just spanning every file in the batch instead of one.
    //
    // A batch may legitimately carry TWO entries for the SAME relPath. The
    // contract is "== calling upsertSymbols(relPath, defs) once per entry, in
    // order" — and sequential per-file upsert is DELETE+INSERT, so a later
    // entry for a file fully REPLACES an earlier one (the second call's DELETE
    // wipes the first's rows). Collapse by relPath keeping LAST-wins BEFORE
    // touching the DB so this holds: each distinct relPath is deleted once and
    // only its final entry's definitions are inserted — never a union of both
    // (a union would leak the superseded entry's rows through INSERT OR IGNORE).
    // Distinct relPaths never share a PK, so cross-file rows never interfere.
    //
    // Within a single surviving entry, INSERT OR IGNORE still preserves
    // first-wins on a duplicate symbolId: row build order iterates definitions
    // in declaration order, so the first occurrence of a (rel_path, symbol_id)
    // pair lands first in the batched VALUES list (see insertOrIgnoreBatched's
    // doc comment for why duplicate-PK rows within one statement are
    // first-row-wins).
    const lastByRelPath = new Map<RelPath, SymbolDefinition[]>();
    for (const { relPath, definitions } of entries) {
      lastByRelPath.set(relPath, definitions);
    }
    await this.exec("BEGIN");
    try {
      for (const relPath of lastByRelPath.keys()) {
        await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      }
      const rows: unknown[][] = [];
      for (const definitions of lastByRelPath.values()) {
        for (const def of definitions) rows.push(toCgSymbolsRow(def));
      }
      await this.insertOrIgnoreBatched("cg_symbols", CG_SYMBOLS_DEF_COLUMNS, rows);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    // Single DELETE is atomic by itself, but still routed through the
    // write queue so it can't interleave with an in-flight BEGIN/COMMIT
    // on the shared connection.
    return this.serialize(async () => this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]));
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth = 5): Promise<number> {
    // Reverse BFS via DuckDB recursive CTE. Seed = files that directly
    // import `relPath`; each round walks one edge further. UNION (vs
    // UNION ALL) deduplicates so each ancestor is counted once even
    // when reached via multiple paths. The depth cap keeps cost
    // predictable on large repos (depth 5 captures most realistic
    // blast radii without exploding on hub files).
    //
    // safeDepth is INLINED rather than bound: bindParams in this client
    // binds every value via bindVarchar (driver constraint — see
    // `bindVarchar non-nullable in @duckdb/node-api 1.5.x` note in
    // adapter docs). DuckDB compares varchar against integer with
    // implicit casts that produce surprising results, so the integer
    // comparison `i.depth < N` must stay literal. The value is
    // sanitised to a small positive integer before substitution, so
    // injection is structurally impossible.
    const safeDepth = Math.max(1, Math.floor(maxDepth));
    // The final WHERE filters the file itself out of the count: in a
    // cyclic dependency graph (A imports B imports A) the recursive
    // walk circles back to the source, but a file is not part of its
    // own blast radius. UNION already ensures each path appears once.
    const rows = await this.queryAll<{ n: number | bigint }>(
      `WITH RECURSIVE impact(rel_path, depth) AS (
         SELECT source_rel_path, 1
         FROM cg_symbols_edges_file
         WHERE target_rel_path = ?
         UNION
         SELECT e.source_rel_path, i.depth + 1
         FROM cg_symbols_edges_file e
         JOIN impact i ON e.target_rel_path = i.rel_path
         WHERE i.depth < ${safeDepth}
       )
       SELECT COUNT(DISTINCT rel_path) AS n FROM impact WHERE rel_path != ?`,
      [relPath, relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    const rows = await this.queryAll<{ cycle_id: number | bigint; member: string; position: number | bigint }>(
      "SELECT cycle_id, member, position FROM cg_symbols_cycles WHERE scope = ? ORDER BY cycle_id, position",
      [scope],
    );
    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      const cycleId = Number(row.cycle_id);
      const arr = grouped.get(cycleId);
      if (arr) arr.push(row.member);
      else grouped.set(cycleId, [row.member]);
    }
    const entries = [...grouped.entries()].map(([cycleId, members]) => ({ cycleId, scope, members }));
    if (!pathPattern) return entries;
    return this.filterCyclesByPath(entries, scope, pathPattern);
  }

  /**
   * Keep a cycle iff AT LEAST ONE of its members resolves to a file path
   * matching `pathPattern`. The "at least one" semantics is deliberate:
   * cycles that cross a scope boundary (one member inside, one outside)
   * are usually the most interesting and must NOT be silently dropped by
   * a stricter "all members match" rule.
   *
   * File scope: a member IS the rel_path → match directly. Method scope:
   * a member is a symbol id; its file path is resolved from the method
   * edge table (source/target rel_path), since `cg_symbols` is only
   * populated by `upsertSymbols`, not by every `upsertFile`.
   */
  private async filterCyclesByPath(
    entries: CycleEntry[],
    scope: CycleScope,
    pathPattern: string,
  ): Promise<CycleEntry[]> {
    const isMatch = picomatch(pathPattern);
    if (scope === "file") {
      return entries.filter((e) => e.members.some((member) => isMatch(member)));
    }
    const symbolToPaths = await this.resolveMethodSymbolPaths(entries.flatMap((e) => e.members));
    return entries.filter((e) => e.members.some((member) => (symbolToPaths.get(member) ?? []).some((p) => isMatch(p))));
  }

  /**
   * Map each given method symbol id to the file path(s) it appears in,
   * read from the method-edge table. Bounded by the cycle membership set
   * via an `IN (…)` filter so the scan never widens to the whole graph.
   */
  private async resolveMethodSymbolPaths(symbolIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const unique = [...new Set(symbolIds)];
    if (unique.length === 0) return map;
    const placeholders = unique.map(() => "?").join(", ");
    const rows = await this.queryAll<{ sym: string; path: string }>(
      `SELECT source_symbol_id AS sym, source_rel_path AS path FROM cg_symbols_edges_method WHERE source_symbol_id IN (${placeholders})
       UNION
       SELECT target_symbol_id AS sym, target_rel_path AS path FROM cg_symbols_edges_method WHERE target_symbol_id IN (${placeholders})`,
      [...unique, ...unique],
    );
    for (const row of rows) {
      const paths = map.get(row.sym);
      if (paths) paths.push(row.path);
      else map.set(row.sym, [row.path]);
    }
    return map;
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

  /**
   * Stream the adjacency for the requested scope as `[source, target]`
   * pairs, fetched from DuckDB one result chunk (~2048 rows) at a time.
   *
   * Method scope additionally carries the per-edge dispatch confidence as a
   * third tuple element (bd tea-rags-mcp-s5ato) — legacy NULL rows coalesce
   * to 1.0 — so the SCC/PageRank consumers can weight dynamic/cone fan-out
   * edges without a second table pass. File edges have no confidence column;
   * the file scope keeps yielding plain `[source, target]` pairs (weight
   * defaults to 1 downstream).
   *
   * TRUE streaming via `connection.stream` + `DuckDBResult.fetchChunk`: only
   * one chunk's rows are resident in JS at any moment. The prior
   * implementation routed through `queryAll` →
   * `runAndReadAll().getRowObjectsJson()`, which materialised the ENTIRE
   * `cg_symbols_edges_method` table into one JS array up front — on a large
   * repo that whole-table copy (alongside the caller's adjacency `Map` and
   * Tarjan/PageRank working sets) was a multi-GB peak and a contributor to the
   * codegraph OOM. Chunked fetch keeps the read half bounded.
   */
  async *streamAdjacency(scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    const sql =
      scope === "file"
        ? "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file"
        : "SELECT source_symbol_id, target_symbol_id, COALESCE(confidence, 1.0) FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL";
    for await (const row of this.streamRows(sql)) {
      const source = row[0];
      const target = row[1];
      // Defensive: WHERE already excludes null targets for method scope, but
      // keep the guard so a null can never become the string "null".
      if (source === null || source === undefined || target === null || target === undefined) continue;
      if (scope === "file") {
        yield [String(source), String(target)];
      } else {
        const weight = row[2];
        yield [String(source), String(target), weight === null || weight === undefined ? 1 : Number(weight)];
      }
    }
  }

  /**
   * Yield result rows one DuckDB chunk at a time (no whole-result
   * materialisation). `connection.stream` returns a result whose
   * `fetchChunk()` pulls the next ~2048-row vector, returning null when
   * drained. Each chunk's column arrays are read via `getRows()` and
   * released before the next fetch.
   */
  private async *streamRows(sql: string): AsyncIterableIterator<DuckDBValue[]> {
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
   * Materialise the adjacency map for the requested scope from the
   * appropriate edge table. For file scope, vertices are relPath; for
   * method scope, vertices are symbolId. Method edges with null
   * target_symbol_id (resolver couldn't pin the call) are skipped —
   * phantom edges pollute graph algorithms downstream.
   *
   * Pure read. Domain orchestrator owns the algorithm (Tarjan,
   * PageRank, …) and calls `replaceCycles` / `replacePageRanks` to
   * persist back. This keeps adapter at the CRUD layer.
   *
   * Kept for backward-compatibility with callers that want the
   * pre-bucketed Map; new callers should prefer `streamAdjacency` and
   * decide their own representation.
   */
  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    if (scope === "file") {
      const rows = await this.queryAll<{ source_rel_path: string; target_rel_path: string }>(
        "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file",
      );
      const adj = new Map<string, string[]>();
      for (const row of rows) {
        const list = adj.get(row.source_rel_path);
        if (list) list.push(row.target_rel_path);
        else adj.set(row.source_rel_path, [row.target_rel_path]);
      }
      return adj;
    }
    const rows = await this.queryAll<{ source_symbol_id: string; target_symbol_id: string | null }>(
      "SELECT source_symbol_id, target_symbol_id FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL",
    );
    const adj = new Map<string, string[]>();
    for (const row of rows) {
      if (row.target_symbol_id === null) continue;
      const list = adj.get(row.source_symbol_id);
      if (list) list.push(row.target_symbol_id);
      else adj.set(row.source_symbol_id, [row.target_symbol_id]);
    }
    return adj;
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    return this.serialize(async () => this.replaceCyclesImpl(scope, sccs));
  }

  private async replaceCyclesImpl(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    await this.exec("BEGIN");
    try {
      await this.run("DELETE FROM cg_symbols_cycles WHERE scope = ?", [scope]);
      const rows: unknown[][] = [];
      for (let cycleId = 0; cycleId < sccs.length; cycleId++) {
        const members = sccs[cycleId];
        for (let position = 0; position < members.length; position++) {
          rows.push([cycleId, scope, members[position], position]);
        }
      }
      await this.insertBatched("cg_symbols_cycles", ["cycle_id", "scope", "member", "position"], rows);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.serialize(async () => this.replacePageRanksImpl(ranks));
  }

  private async replacePageRanksImpl(ranks: ReadonlyMap<string, number>): Promise<void> {
    await this.exec("BEGIN");
    try {
      await this.exec("DELETE FROM cg_symbols_metrics");
      const rows = [...ranks].map(([symbolId, rank]) => [symbolId, String(rank)]);
      await this.insertBatched("cg_symbols_metrics", ["symbol_id", "page_rank"], rows);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async getPageRank(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ page_rank: number | bigint | string }>(
      "SELECT page_rank FROM cg_symbols_metrics WHERE symbol_id = ?",
      [symbolId],
    );
    const raw = rows[0]?.page_rank;
    return raw === undefined ? 0 : Number(raw);
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    const rows = await this.queryAll<CgSymbolsRow>(`SELECT ${CG_SYMBOLS_DEF_COLUMNS.join(", ")} FROM cg_symbols`);
    return rows.map(fromCgSymbolsRow);
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    if (chunkIds.size === 0) return;
    return this.serialize(async () => {
      await this.exec("BEGIN");
      try {
        for (const [symbolId, chunkId] of chunkIds) {
          await this.run("UPDATE cg_symbols SET chunk_id = ? WHERE rel_path = ? AND symbol_id = ?", [
            chunkId,
            relPath,
            symbolId,
          ]);
        }
        await this.exec("COMMIT");
      } catch (err) {
        await this.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    // Tier 1 — exact symbol_id match (the canonical fast path, indexed).
    const exact = await this.queryAll<{ rel_path: string; chunk_id: string | null }>(
      "SELECT rel_path, chunk_id FROM cg_symbols WHERE symbol_id = ? AND chunk_id IS NOT NULL LIMIT 1",
      [symbolId],
    );
    if (exact.length > 0) return { relPath: exact[0].rel_path, chunkId: exact[0].chunk_id as string };

    // Tier 2 — last-name-segment fallback. Rails DSL-defined symbols
    // (`scope`/`has_many`/`delegate`) are minted in cg_symbols under their
    // concern/module FQN (e.g. `Account::Suspensions.suspended`), but the
    // covering body chunk's payload symbolId is the parent module — so the
    // Qdrant scroll AND the exact tier above both miss a bare ("suspended") or
    // host-class ("Account.suspended") query. Resolve by the query's trailing
    // name segment so the symbol's already-joined chunk (and its edges) surface
    // via the symbol-API. Mirrors the bare-name last-segment match the Qdrant
    // SymbolSearchStrategy applies for `def` methods. See bd tea-rags-mcp-mtlhd.
    const tail = lastNameSegment(symbolId);
    if (tail.length === 0) return null;
    const likeTail = escapeLikeLiteral(tail);
    const bySegment = await this.queryAll<{ rel_path: string; chunk_id: string | null }>(
      `SELECT rel_path, chunk_id FROM cg_symbols
         WHERE chunk_id IS NOT NULL
           AND ( symbol_id = ?
              OR symbol_id LIKE ? ESCAPE '\\'
              OR symbol_id LIKE ? ESCAPE '\\'
              OR symbol_id LIKE ? ESCAPE '\\' )
         ORDER BY symbol_id
         LIMIT 1`,
      [tail, `%.${likeTail}`, `%#${likeTail}`, `%::${likeTail}`],
    );
    if (bySegment.length === 0) return null;
    return { relPath: bySegment[0].rel_path, chunkId: bySegment[0].chunk_id as string };
  }

  async getFanIn(relPath: RelPath): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE target_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE source_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getFanInP95(): Promise<number> {
    // Per-file fanIn = COUNT of edges whose target is that file — the same
    // metric `getFanIn(relPath)` returns for one file. The percentile is
    // taken over the FULL file universe (cg_symbols_files), LEFT JOINed
    // against per-target edge counts so files with zero incoming edges
    // contribute fanIn=0 to the distribution. A hub is relative to ALL
    // files (including leaves), so the zero-fanIn tail must be present.
    //
    // Anchoring on cg_symbols_files (not on the edge table's distinct
    // targets) is what makes this correct under incremental reindex: the
    // first pass has already brought the whole graph up to date, and this
    // query reads the entire collection rather than the changed-file
    // subset the overlay loop iterates.
    //
    // PERCENTILE_CONT yields NULL on an empty universe (no files) — COALESCE
    // to 0 so the caller's `fanIn > p95` comparison degenerates sanely.
    const rows = await this.queryAll<{ p95: number | null }>(
      `WITH file_fan_in AS (
         SELECT f.rel_path AS rel_path, COUNT(e.source_rel_path) AS fan_in
         FROM cg_symbols_files f
         LEFT JOIN cg_symbols_edges_file e ON e.target_rel_path = f.rel_path
         GROUP BY f.rel_path
       )
       SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY fan_in), 0) AS p95
       FROM file_fan_in`,
    );
    return Number(rows[0]?.p95 ?? 0);
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    const direct = await this.queryAll<CallerEdge>(
      'SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id',
      [symbolId],
    );
    // bd tea-rags-mcp-2jet-E — symmetric CHA cone expansion. A large cone was
    // capped to ONE `poly-base` edge to the base declaration `T#m`. Callers of a
    // concrete override `Sub#m` must therefore ALSO include any caller that
    // (polymorphically) targeted `T#m` via poly-base, for every ancestor `T` of
    // `Sub`. Re-derive those callers through the forward inheritance index.
    const split = splitMethodSymbol(symbolId);
    if (!split) return direct;
    const polyBaseCallers = await this.queryAll<CallerEdge>(
      `SELECT m.source_symbol_id AS "sourceSymbolId", m.source_rel_path AS "sourceRelPath", m.call_expression AS "callExpression", m.edge_kind AS "edgeKind", m.confidence
         FROM cg_symbols_edges_method m
         JOIN cg_symbols_inheritance i ON i.source_fq_name = ?
        WHERE m.edge_kind = 'poly-base'
          AND m.target_symbol_id = i.ancestor_fq_name || ? || ?
        ORDER BY m.source_rel_path, m.source_symbol_id`,
      [split.base, split.sep, split.member],
    );
    if (polyBaseCallers.length === 0) return direct;
    return dedupeCallerEdges([...direct, ...polyBaseCallers]);
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    const edges = await this.queryAll<CalleeEdge & { edgeKind: MethodEdgeKind | null; confidence: number | null }>(
      `SELECT target_symbol_id AS "targetSymbolId", target_rel_path AS "targetRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence
         FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path`,
      [symbolId],
    );
    const out: CalleeEdge[] = [];
    for (const e of edges) {
      const base: CalleeEdge = {
        targetSymbolId: e.targetSymbolId,
        targetRelPath: e.targetRelPath,
        callExpression: e.callExpression,
        edgeKind: e.edgeKind ?? undefined,
        confidence: e.confidence ?? undefined,
      };
      out.push(base);
      // bd tea-rags-mcp-2jet-E — expand a `poly-base` edge to the overriding
      // subtypes at query time. The persisted edge points at the base decl
      // `T#m`; the reverse inheritance index yields the subtypes, and we keep
      // only those that actually DECLARE the override (an existing `Sub#m`
      // symbol). The base edge stays so a concrete base implementation is not
      // lost.
      if (e.edgeKind === "poly-base" && e.targetSymbolId) {
        out.push(...(await this.expandPolyBaseCallees(e.targetSymbolId, e.callExpression)));
      }
    }
    return out;
  }

  /**
   * Re-derive the overriding-subtype callee edges for a capped `poly-base` edge
   * (bd tea-rags-mcp-2jet-E). `baseTarget` is `T#m`; for each direct subtype `S`
   * of `T` that declares its own `S#m`, emit one callee edge. Subtypes that only
   * inherit `m` (no own declaration) are skipped — synthesizing `S#m` for them
   * would point at a symbol that does not exist.
   */
  private async expandPolyBaseCallees(baseTarget: SymbolId, callExpression: string): Promise<CalleeEdge[]> {
    const split = splitMethodSymbol(baseTarget);
    if (!split) return [];
    const rows = await this.queryAll<{ targetSymbolId: SymbolId; targetRelPath: RelPath }>(
      `SELECT s.symbol_id AS "targetSymbolId", s.rel_path AS "targetRelPath"
         FROM cg_symbols_inheritance i
         JOIN cg_symbols s ON s.symbol_id = i.source_fq_name || ? || ?
        WHERE i.ancestor_fq_name = ?
        ORDER BY s.symbol_id`,
      [split.sep, split.member, split.base],
    );
    return rows.map((r) => ({ targetSymbolId: r.targetSymbolId, targetRelPath: r.targetRelPath, callExpression }));
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    const out = new Map<SymbolId, SymbolId[]>();
    if (symbolIds.length === 0) return out;
    const placeholders = symbolIds.map(() => "?").join(", ");
    const rows = await this.queryAll<{ source: SymbolId; target: SymbolId }>(
      // Navigation filter mirrors isNavigationVisibleEdge() in graph-facade.ts (xlnub Task 5):
      // dynamic edges with confidence < 1 are hidden from BFS traversal; all other
      // edge kinds (cone/exact/poly-base/registry) and legacy NULL-edgeKind edges are traversable.
      `SELECT source_symbol_id AS source, target_symbol_id AS target
       FROM cg_symbols_edges_method
       WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IS NOT NULL
         AND NOT (edge_kind = 'dynamic' AND COALESCE(confidence, 1) < 1)
       ORDER BY source_symbol_id, target_symbol_id`,
      symbolIds,
    );
    for (const { source, target } of rows) {
      const list = out.get(source);
      if (list) list.push(target);
      else out.set(source, [target]);
    }
    return out;
  }

  /**
   * Lazy ambiguous-group expansion read (bd tea-rags-mcp-f2jsb A4). Selects
   * the `cg_ambiguous_fanout` aggregates whose `member` equals the target's
   * member segment — uses the migration-013 member index. The suppressed
   * edges are NEVER materialized; consumers see the aggregate + its
   * candidateCount. `limit` is INLINED (not bound) for the same reason as
   * `getTransitiveImpact`'s depth: bindParams binds every value via
   * bindVarchar and a varchar LIMIT misbehaves — the value is sanitised to a
   * small positive integer first, so injection is structurally impossible.
   * Empty member short-circuits to [] (the kernel always records a non-empty
   * member, so nothing can match).
   */
  async getAmbiguousCallersByMember(member: string, limit = 50): Promise<AmbiguousCallerSite[]> {
    if (member.length === 0) return [];
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = await this.queryAll<{
      sourceSymbolId: string;
      sourceRelPath: string;
      callExpression: string;
      candidateCount: number | bigint;
    }>(
      `SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath",
              call_expression AS "callExpression", candidate_count AS "candidateCount"
         FROM cg_ambiguous_fanout WHERE member = ?
        ORDER BY source_symbol_id, call_expression
        LIMIT ${safeLimit}`,
      [member],
    );
    return rows.map((r) => ({
      sourceSymbolId: r.sourceSymbolId,
      sourceRelPath: r.sourceRelPath,
      callExpression: r.callExpression,
      candidateCount: Number(r.candidateCount),
    }));
  }

  /**
   * Confidence-weighted chunk fanIn (bd tea-rags-mcp-s5ato): SUM(confidence)
   * over incoming method edges instead of COUNT(*). A dynamic/cone dispatch
   * site that fans out to m candidates at confidence 1/m contributes ~1 call
   * site in total — COUNT(*) previously inflated every fan-out target into a
   * fake hub (m× per fan). Exact edges and legacy NULL-confidence rows weigh
   * 1.0, so purely-exact graphs keep integer counts. The result is a FLOAT,
   * rounded to 2 decimals at this boundary (see `roundEdgeWeightSum`).
   */
  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number | null }>(
      "SELECT SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = ?",
      [symbolId],
    );
    return roundEdgeWeightSum(Number(rows[0]?.n ?? 0));
  }

  /**
   * Confidence-weighted chunk fanOut — counterpart of `getCalledByCount`:
   * SUM(confidence) over outgoing method edges, so a whole m-way fan-out
   * (m edges at 1/m) counts as ONE outgoing call. Same NULL→1.0 legacy
   * coalesce and 2-decimal boundary rounding.
   */
  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number | null }>(
      "SELECT SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = ?",
      [symbolId],
    );
    return roundEdgeWeightSum(Number(rows[0]?.n ?? 0));
  }

  /**
   * Set-based read-back of `{ fanIn, fanOut, pageRank }` for every symbol in the
   * graph — the batched replacement for looping `getCalledByCount` +
   * `getCallSiteCount` + `getPageRank` per chunk (`buildChunkSignals`). Three
   * whole-table GROUP-BY / scan queries (no `IN (…)` list → no param-limit
   * chunking) instead of `3 × chunkCount` point queries. Each value is computed
   * identically to the per-symbol getter — same `SUM(COALESCE(confidence, 1.0))`
   * with `roundEdgeWeightSum`, same `Number()` pageRank — so a caller that reads
   * `map.get(id) ?? { 0, 0, 0 }` gets byte-identical results.
   */
  async getChunkSignalsBulk(): Promise<Map<SymbolId, ChunkGraphSignals>> {
    const out = new Map<SymbolId, ChunkGraphSignals>();
    const entryFor = (id: string): ChunkGraphSignals => {
      let e = out.get(id);
      if (!e) {
        e = { fanIn: 0, fanOut: 0, pageRank: 0 };
        out.set(id, e);
      }
      return e;
    };
    const fanInRows = await this.queryAll<{ id: string; n: number | null }>(
      "SELECT target_symbol_id AS id, SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method GROUP BY target_symbol_id",
    );
    for (const r of fanInRows) entryFor(r.id).fanIn = roundEdgeWeightSum(Number(r.n ?? 0));
    const fanOutRows = await this.queryAll<{ id: string; n: number | null }>(
      "SELECT source_symbol_id AS id, SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method GROUP BY source_symbol_id",
    );
    for (const r of fanOutRows) entryFor(r.id).fanOut = roundEdgeWeightSum(Number(r.n ?? 0));
    const pageRankRows = await this.queryAll<{ id: string; page_rank: number | bigint | string }>(
      "SELECT symbol_id AS id, page_rank FROM cg_symbols_metrics",
    );
    for (const r of pageRankRows) entryFor(r.id).pageRank = Number(r.page_rank);
    return out;
  }

  async hasData(): Promise<boolean> {
    const rows = await this.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_symbols_files");
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    return this.serialize(async () => {
      // Overwrite semantics: DELETE+INSERT inside one transaction so a prior
      // run's receiver kinds never leak into this run's breakdown.
      await this.exec("BEGIN");
      try {
        await this.run("DELETE FROM cg_run_stats");
        for (const r of rows) {
          await this.run(
            "INSERT INTO cg_run_stats (language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              r.language,
              r.receiverKind,
              r.attempted,
              r.resolved,
              r.externalSkipped,
              r.unresolvable,
              r.noInProjectDef ?? 0,
              r.coreAmbiguous ?? 0,
              r.ambiguousFanout ?? 0,
            ],
          );
        }
        await this.exec("COMMIT");
      } catch (err) {
        await this.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    const rows = await this.queryAll<{
      language: string;
      receiver_kind: string;
      attempted: number | bigint;
      resolved: number | bigint;
      external_skipped: number | bigint;
      unresolvable: number | bigint;
      no_in_project_def: number | bigint;
      core_ambiguous: number | bigint;
      ambiguous_fanout: number | bigint;
    }>(
      "SELECT language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout FROM cg_run_stats ORDER BY language, receiver_kind",
    );
    return rows.map((r) => ({
      language: r.language,
      receiverKind: r.receiver_kind,
      attempted: Number(r.attempted),
      resolved: Number(r.resolved),
      externalSkipped: Number(r.external_skipped),
      unresolvable: Number(r.unresolvable),
      noInProjectDef: Number(r.no_in_project_def),
      coreAmbiguous: Number(r.core_ambiguous),
      ambiguousFanout: Number(r.ambiguous_fanout),
    }));
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    const rows = await this.queryAll<{ edge_kind: string; cnt: number | bigint }>(
      "SELECT edge_kind, COUNT(*) AS cnt FROM cg_symbols_edges_method GROUP BY edge_kind ORDER BY edge_kind",
    );
    return rows.map((r) => ({ edgeKind: r.edge_kind as MethodEdgeKind, count: Number(r.cnt) }));
  }

  // ── Class hierarchy (bd tea-rags-mcp-f10y) ──

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.queryAll<{
      ancestorFqName: string;
      ancestorSymbolId: string | null;
      kind: InheritanceKind;
    }>(
      `SELECT ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind
         FROM cg_symbols_inheritance WHERE source_fq_name = ? ORDER BY ordinal, ancestor_fq_name`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: fqName,
      ancestorFqName: r.ancestorFqName,
      ancestorSymbolId: r.ancestorSymbolId,
      kind: r.kind,
      depth: 1,
    }));
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.queryAll<{ sourceFqName: string; kind: InheritanceKind }>(
      `SELECT source_fq_name AS "sourceFqName", kind
         FROM cg_symbols_inheritance WHERE ancestor_fq_name = ? ORDER BY source_fq_name`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: r.sourceFqName,
      ancestorFqName: fqName,
      ancestorSymbolId: null,
      kind: r.kind,
      depth: 1,
    }));
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.queryAll<{
      sourceFqName: string;
      ancestorFqName: string;
      kind: InheritanceKind;
      depth: number | bigint;
    }>(
      `WITH RECURSIVE sub(source_fq_name, ancestor_fq_name, kind, depth) AS (
         SELECT source_fq_name, ancestor_fq_name, kind, 1
           FROM cg_symbols_inheritance WHERE ancestor_fq_name = ?
         UNION ALL
         SELECT c.source_fq_name, c.ancestor_fq_name, c.kind, sub.depth + 1
           FROM cg_symbols_inheritance c JOIN sub ON c.ancestor_fq_name = sub.source_fq_name
       )
       SELECT source_fq_name AS "sourceFqName", ancestor_fq_name AS "ancestorFqName", kind, depth FROM sub`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: r.sourceFqName,
      ancestorFqName: r.ancestorFqName,
      ancestorSymbolId: null,
      kind: r.kind,
      depth: Number(r.depth),
    }));
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    const rows = await this.queryAll<{
      sourceFqName: string;
      sourceSymbolId: string | null;
      ancestorFqName: string;
      ancestorSymbolId: string | null;
      kind: InheritanceKind;
      ordinal: number | bigint;
    }>(
      `SELECT source_fq_name AS "sourceFqName", source_symbol_id AS "sourceSymbolId",
              ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind, ordinal
         FROM cg_symbols_inheritance ORDER BY source_fq_name, ordinal`,
    );
    const ancestorsBySource: Record<string, InheritanceEdgeRow[]> = {};
    const descendantsByAncestor: Record<string, InheritanceEdgeRow[]> = {};
    for (const r of rows) {
      const row: InheritanceEdgeRow = {
        sourceFqName: r.sourceFqName,
        sourceSymbolId: r.sourceSymbolId,
        ancestorFqName: r.ancestorFqName,
        ancestorSymbolId: r.ancestorSymbolId,
        kind: r.kind,
        ordinal: Number(r.ordinal),
      };
      (ancestorsBySource[row.sourceFqName] ??= []).push(row);
      (descendantsByAncestor[row.ancestorFqName] ??= []).push(row);
    }
    return { ancestorsBySource, descendantsByAncestor };
  }

  private requireConn(): DuckDBConnection {
    if (!this.conn) throw new Error("DuckDbGraphClient: init() must be called before use");
    return this.conn;
  }
}

// Bind a positional parameter list onto a prepared statement, mapping
// the small set of value shapes the codegraph DDL uses today
// (VARCHAR everywhere — including the integer-shape columns, which DuckDB
// coerces transparently). If a new column type lands later, extend here.
type BindablePrimitive = string | number | boolean | null | undefined;

function asBindable(params: unknown[]): BindablePrimitive[] {
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p === "string" || typeof p === "number" || typeof p === "boolean") return p;
    throw new Error(`DuckDbGraphClient: unsupported bind param type ${typeof p} (value: ${JSON.stringify(p)})`);
  });
}

interface BindablePrep {
  bindVarchar: (i: number, v: string) => void;
  bindNull: (i: number) => void;
}

function bindParams(prep: BindablePrep, params: BindablePrimitive[]): void {
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v === null || v === undefined) {
      prep.bindNull(i + 1);
    } else {
      prep.bindVarchar(i + 1, String(v));
    }
  }
}

function parseScope(json: string): string[] {
  // Scope is stored as JSON-encoded VARCHAR (see migration 002 — DuckDB
  // list-type bindings add complexity for a small array). Tolerate a
  // malformed scalar by returning empty: a missing scope chain degrades
  // resolver precision but never crashes hydration.
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Split a method symbolId into its declaring type, the class↔member separator,
 * and the member (bd tea-rags-mcp-2jet-E). Per `symbolid-convention.md` the
 * separator between class and member is `#` (instance) or `.` (static); `::`
 * (Ruby/Rust namespace) is NOT a member boundary. The LAST `#` wins when
 * present (so `Acme::User#save` → base `Acme::User`, member `save`); otherwise
 * fall back to the last `.`. Returns `null` for a bare top-level symbol with no
 * member separator — nothing to expand.
 *
 * Exported for the GraphFacade's lazy ambiguous expansion (bd f2jsb A4): the
 * `includeAmbiguous` read extracts the target's member segment with the same
 * convention this adapter persists `cg_ambiguous_fanout.member` under.
 */
export function splitMethodSymbol(symbolId: SymbolId): { base: string; sep: "#" | "."; member: string } | null {
  const hash = symbolId.lastIndexOf("#");
  if (hash > 0 && hash < symbolId.length - 1) {
    return { base: symbolId.slice(0, hash), sep: "#", member: symbolId.slice(hash + 1) };
  }
  const dot = symbolId.lastIndexOf(".");
  if (dot > 0 && dot < symbolId.length - 1) {
    return { base: symbolId.slice(0, dot), sep: ".", member: symbolId.slice(dot + 1) };
  }
  return null;
}

/**
 * Dedupe caller edges by `(sourceSymbolId, callExpression)` (bd 2jet-E). The
 * symmetric poly-base expansion can re-surface a caller the direct query already
 * returned (e.g. a class that both directly calls the override AND reaches it
 * polymorphically). First occurrence wins; ordering of the merged list is
 * preserved.
 */
function dedupeCallerEdges(edges: CallerEdge[]): CallerEdge[] {
  const seen = new Set<string>();
  const out: CallerEdge[] = [];
  for (const e of edges) {
    const k = `${e.sourceSymbolId} ${e.callExpression}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Trailing name segment of a symbolId — the part after the final structural
 * separator (`#` instance, `.` static, `::` namespace; see
 * `.claude/rules/symbolid-convention.md`). Ruby method-name suffixes (`?!=`) are
 * preserved (`Foo#valid?` → `valid?`). A bare name with no separator is returned
 * unchanged. Used by the `findSymbolChunk` last-segment fallback (mtlhd).
 */
function lastNameSegment(symbol: string): string {
  const parts = symbol.split(/[#.]|::/);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Escape SQL `LIKE` metacharacters (`%`, `_`) and the escape char itself so a
 * literal symbol-name segment (identifiers routinely contain `_`) matches
 * verbatim under `LIKE … ESCAPE '\'`. Without this, `status_scope` would match
 * `statusXscope`.
 */
function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Boundary rounding for confidence-weighted edge sums (bd tea-rags-mcp-s5ato).
 * The `confidence` column is REAL (float32) and SUM accumulates in DOUBLE, so
 * three 1/3-confidence edges yield 1.0000000298… — round to 2 decimals so
 * float noise never leaks into Qdrant payloads while fractional weights
 * (e.g. fanIn 1.25) survive intact. Deliberately NOT Math.round to integer:
 * consumers (chunk fanIn/fanOut payload signals, derived-signal normalization,
 * range filters) all tolerate non-integers, and the fraction IS the signal.
 */
function roundEdgeWeightSum(sum: number): number {
  return Math.round(sum * 100) / 100;
}
