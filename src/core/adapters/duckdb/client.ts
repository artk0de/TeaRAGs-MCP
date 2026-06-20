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
  CalleeEdge,
  CallerEdge,
  CycleEntry,
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
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
      await this.run("INSERT OR REPLACE INTO cg_symbols_files (rel_path, language) VALUES (?, ?)", [
        node.relPath,
        node.language,
      ]);
      await this.run("DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ?", [node.relPath]);
      await this.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?", [node.relPath]);
      for (const e of edges.fileEdges) {
        // INSERT OR IGNORE: dedupe (source, target) — a file may
        // re-import the same module on different lines, producing the
        // same edge twice in one extraction batch.
        await this.run(
          "INSERT OR IGNORE INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)",
          [node.relPath, e.targetRelPath, e.importText],
        );
      }
      for (const e of edges.methodEdges) {
        // GraphEdges.methodEdges allows targetSymbolId=null (the
        // resolver case where an import resolves to a file but the
        // called member isn't in that file's exported symbol table).
        // The cg_symbols_edges_method PK includes target_symbol_id —
        // DuckDB enforces NOT NULL on PK columns, so we must skip
        // null-target edges at the boundary. File-level reach is
        // already captured by fileEdges; the method graph only carries
        // edges with a known target symbol.
        if (e.targetSymbolId === null) continue;
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
        await this.run(
          "INSERT OR IGNORE INTO cg_symbols_edges_method (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            e.sourceSymbolId,
            node.relPath,
            e.targetSymbolId,
            e.targetRelPath,
            e.callExpression,
            e.edgeKind ?? "exact",
            e.confidence ?? 1.0,
          ],
        );
      }
      // Inheritance edges (bd tea-rags-mcp-f10y). Per-source-file delete+insert,
      // same lifecycle as the edge tables: re-walking a file replaces its rows.
      // INSERT OR IGNORE dedupes a (source, ancestor, kind) declared twice in
      // one extraction (e.g. duplicate include).
      await this.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [node.relPath]);
      for (const e of edges.inheritance ?? []) {
        await this.run(
          `INSERT OR IGNORE INTO cg_symbols_inheritance
             (source_fq_name, source_rel_path, source_symbol_id, ancestor_fq_name, ancestor_symbol_id, kind, ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [e.sourceFqName, node.relPath, e.sourceSymbolId, e.ancestorFqName, e.ancestorSymbolId, e.kind, e.ordinal],
        );
      }
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
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
        await this.run(
          "INSERT OR IGNORE INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
          [def.relPath, def.symbolId, def.fqName, def.shortName, JSON.stringify(def.scope ?? [])],
        );
      }
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
   * TRUE streaming via `connection.stream` + `DuckDBResult.fetchChunk`: only
   * one chunk's rows are resident in JS at any moment. The prior
   * implementation routed through `queryAll` →
   * `runAndReadAll().getRowObjectsJson()`, which materialised the ENTIRE
   * `cg_symbols_edges_method` table into one JS array up front — on a large
   * repo that whole-table copy (alongside the caller's adjacency `Map` and
   * Tarjan/PageRank working sets) was a multi-GB peak and a contributor to the
   * codegraph OOM. Chunked fetch keeps the read half bounded.
   */
  async *streamAdjacency(scope: CycleScope): AsyncIterableIterator<[string, string]> {
    const sql =
      scope === "file"
        ? "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file"
        : "SELECT source_symbol_id, target_symbol_id FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL";
    for await (const row of this.streamRows(sql)) {
      const source = row[0];
      const target = row[1];
      // Defensive: WHERE already excludes null targets for method scope, but
      // keep the guard so a null can never become the string "null".
      if (source === null || source === undefined || target === null || target === undefined) continue;
      yield [String(source), String(target)];
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
      for (let cycleId = 0; cycleId < sccs.length; cycleId++) {
        const members = sccs[cycleId];
        for (let position = 0; position < members.length; position++) {
          await this.run("INSERT INTO cg_symbols_cycles (cycle_id, scope, member, position) VALUES (?, ?, ?, ?)", [
            cycleId,
            scope,
            members[position],
            position,
          ]);
        }
      }
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
      for (const [symbolId, rank] of ranks) {
        await this.run("INSERT INTO cg_symbols_metrics (symbol_id, page_rank) VALUES (?, ?)", [symbolId, String(rank)]);
      }
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
    const rows = await this.queryAll<{
      rel_path: string;
      symbol_id: string;
      fq_name: string;
      short_name: string;
      scope_json: string;
    }>("SELECT rel_path, symbol_id, fq_name, short_name, scope_json FROM cg_symbols");
    return rows.map((row) => ({
      relPath: row.rel_path,
      symbolId: row.symbol_id,
      fqName: row.fq_name,
      shortName: row.short_name,
      scope: parseScope(row.scope_json),
    }));
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
    const rows = await this.queryAll<{ rel_path: string; chunk_id: string | null }>(
      "SELECT rel_path, chunk_id FROM cg_symbols WHERE symbol_id = ? AND chunk_id IS NOT NULL LIMIT 1",
      [symbolId],
    );
    if (rows.length === 0) return null;
    return { relPath: rows[0].rel_path, chunkId: rows[0].chunk_id as string };
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
      'SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath", call_expression AS "callExpression" FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id',
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
      `SELECT m.source_symbol_id AS "sourceSymbolId", m.source_rel_path AS "sourceRelPath", m.call_expression AS "callExpression"
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
    const edges = await this.queryAll<CalleeEdge & { edgeKind: MethodEdgeKind }>(
      `SELECT target_symbol_id AS "targetSymbolId", target_rel_path AS "targetRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind"
         FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path`,
      [symbolId],
    );
    const out: CalleeEdge[] = [];
    for (const e of edges) {
      const base: CalleeEdge = {
        targetSymbolId: e.targetSymbolId,
        targetRelPath: e.targetRelPath,
        callExpression: e.callExpression,
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
      `SELECT source_symbol_id AS source, target_symbol_id AS target
       FROM cg_symbols_edges_method
       WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IS NOT NULL
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

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = ?",
      [symbolId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = ?",
      [symbolId],
    );
    return Number(rows[0]?.n ?? 0);
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
            "INSERT INTO cg_run_stats (receiver_kind, attempted, resolved, external_skipped) VALUES (?, ?, ?, ?)",
            [r.receiverKind, r.attempted, r.resolved, r.externalSkipped],
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
      receiver_kind: string;
      attempted: number | bigint;
      resolved: number | bigint;
      external_skipped: number | bigint;
    }>("SELECT receiver_kind, attempted, resolved, external_skipped FROM cg_run_stats ORDER BY receiver_kind");
    return rows.map((r) => ({
      receiverKind: r.receiver_kind,
      attempted: Number(r.attempted),
      resolved: Number(r.resolved),
      externalSkipped: Number(r.external_skipped),
    }));
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
 */
function splitMethodSymbol(symbolId: SymbolId): { base: string; sep: "#" | "."; member: string } | null {
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
    const k = `${e.sourceSymbolId} ${e.callExpression}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
