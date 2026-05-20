/**
 * DuckDB implementation of the codegraph `GraphDbClient` contract.
 *
 * Slice 1 uses an embedded, file-backed DuckDB instance per `App`, named
 * `<collection>.codegraph.duckdb` under the data directory. Slice 4 adds
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

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import type {
  CalleeEdge,
  CallerEdge,
  CycleEntry,
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolDefinition,
  SymbolId,
} from "../../contracts/types/codegraph.js";

// Graph algorithms (Tarjan SCC, PageRank) intentionally NOT imported
// here. Per the layering rules in .claude/rules/domain-boundaries.md
// adapters/ may not import from domains/. Cycle/PageRank computation
// lives in domains/trajectory/codegraph/infra/ and the adapter only
// exposes the primitives (listAdjacency, replaceCycles, replacePageRanks)
// the domain orchestrator drives.

export interface DuckDbGraphClientOptions {
  path: string;
}

export class DuckDbGraphClient implements GraphDbClient {
  private instance?: DuckDBInstance;
  private conn?: DuckDBConnection;

  constructor(private readonly options: DuckDbGraphClientOptions) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.options.path), { recursive: true });
    this.instance = await DuckDBInstance.create(this.options.path);
    this.conn = await this.instance.connect();
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

  /** Generic prepared exec with positional params. */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    const prep = await this.requireConn().prepare(sql);
    bindParams(prep, asBindable(params));
    await prep.run();
  }

  /** Generic query returning all rows as plain JSON objects. */
  async queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const prep = await this.requireConn().prepare(sql);
    bindParams(prep, asBindable(params));
    const reader = await prep.runAndReadAll();
    return reader.getRowObjectsJson() as T[];
  }

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
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
        // INSERT OR IGNORE: same call shape may repeat — e.g.
        // `this.cache.get(x)` invoked from multiple branches of the
        // same method body. collectCalls walks every call_expression
        // and emits one CallRef per occurrence; the PK
        // (source_symbol_id, call_expression, target_symbol_id) is
        // edge-existence semantics, not occurrence count.
        await this.run(
          "INSERT OR IGNORE INTO cg_symbols_edges_method (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression) VALUES (?, ?, ?, ?, ?)",
          [e.sourceSymbolId, node.relPath, e.targetSymbolId, e.targetRelPath, e.callExpression],
        );
      }
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async removeFile(relPath: RelPath): Promise<void> {
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
      await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      await this.run("DELETE FROM cg_symbols_files WHERE rel_path = ?", [relPath]);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    // DELETE+INSERT inside a transaction so a partial failure leaves
    // either the full new set or the previous set — never a mix. Empty
    // definitions list clears the file (idempotent with handleDeletedPaths).
    await this.exec("BEGIN");
    try {
      await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      for (const def of definitions) {
        await this.run(
          "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
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
    // No transaction wrapper — single DELETE is atomic by itself.
    await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
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

  async findCycles(scope: CycleScope): Promise<CycleEntry[]> {
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
    return [...grouped.entries()].map(([cycleId, members]) => ({ cycleId, scope, members }));
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

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return this.queryAll<CallerEdge>(
      'SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath", call_expression AS "callExpression" FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id',
      [symbolId],
    );
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return this.queryAll<CalleeEdge>(
      'SELECT target_symbol_id AS "targetSymbolId", target_rel_path AS "targetRelPath", call_expression AS "callExpression" FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path',
      [symbolId],
    );
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
