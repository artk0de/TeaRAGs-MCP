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
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolId,
} from "../../contracts/types/codegraph.js";

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
      await this.run("DELETE FROM cg_symbols_files WHERE rel_path = ?", [relPath]);
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
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
