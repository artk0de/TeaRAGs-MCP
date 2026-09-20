import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "026-cg-method-edges-nullable-target.sql";
const PRE_026 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-rtp6v — `cg_symbols_edges_method` keyed its PRIMARY KEY on
 * `target_symbol_id` (001, re-keyed with `source_rel_path` by 020), and DuckDB
 * forces every PK column NOT NULL — so a method edge whose target symbol the
 * resolver could not pin (the file-only edge, e.g. the checker proved the file
 * but no exported symbol table names the member) was uninsertable, and the
 * write path skipped it silently. A file-only edge was NO edge, at no error at
 * any layer.
 *
 * 026 rebuilds the table (020's pattern: CREATE new → INSERT OR IGNORE SELECT
 * → DROP old → RENAME → recreate the three secondary indexes) with the key
 * `(source_symbol_id, source_rel_path, call_expression, target_rel_path,
 * target_symbol_key)`; `target_symbol_id` becomes a plain nullable VARCHAR
 * column. The fifth member is the PK-safe sentinel of target_symbol_id
 * (`COALESCE(id, '')`) — the one deviation from the decided 4-tuple, taken on
 * evidence: without it every same-file dispatch/interface fan-out (bd
 * tea-rags-mcp-n0zj / t5cji) would collapse to its first candidate, the exact
 * silent-drop class this migration removes. The
 * `(source_symbol_id, source_rel_path)` prefix — the frontier-expansion
 * predicate behind getCalleeEdges — stays at the front.
 */
describe("026 re-keys the method-edge PK without target_symbol_id", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-nullable-target-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function primaryKeyColumns(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ constraint_column_names: string[] }>(
      "SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
      [table],
    );
    return rows[0]?.constraint_column_names ?? [];
  }

  async function indexesOn(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = ? ORDER BY index_name",
      [table],
    );
    return rows.map((r) => r.index_name);
  }

  it("keys the table on the call site plus a NOT NULL target_symbol_key sentinel", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Order is load-bearing: (source_symbol_id, source_rel_path) stays the
    // front prefix the getCalleeEdges-shape lookups use; target_rel_path and
    // the sentinel replace target_symbol_id as key members. The sentinel is
    // the one deviation from the decided 4-tuple, taken on evidence: without
    // it every same-file dispatch/interface fan-out (bd tea-rags-mcp-n0zj /
    // t5cji) would collapse to its first candidate — the silent-drop class
    // this migration exists to remove.
    expect(await primaryKeyColumns("cg_symbols_edges_method")).toEqual([
      "source_symbol_id",
      "source_rel_path",
      "call_expression",
      "target_rel_path",
      "target_symbol_key",
    ]);
  });

  it("accepts a null-target (file-only) method edge as a stored row", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, target_symbol_key, edge_kind, confidence)
       VALUES (?, ?, NULL, ?, ?, '', 'exact', 1.0)`,
      ["Caller#run", "src/caller.ts", "src/only-file.ts", "fetcher.request()"],
    );

    const rows = await db.queryAll<{ target_symbol_id: string | null; target_rel_path: string }>(
      "SELECT target_symbol_id, target_rel_path FROM cg_symbols_edges_method",
    );
    expect(rows).toEqual([{ target_symbol_id: null, target_rel_path: "src/only-file.ts" }]);
  });

  it("NON-VACUITY: the same insert is rejected under the pre-026 key", async () => {
    await runMigrations(db, PRE_026);

    let message = "accepted";
    try {
      await db.run(
        `INSERT INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
         VALUES (?, ?, NULL, ?, ?, 'exact', 1.0)`,
        ["Caller#run", "src/caller.ts", "src/only-file.ts", "fetcher.request()"],
      );
    } catch (err) {
      ({ message } = err as Error);
    }
    expect(message).toContain("NOT NULL constraint failed");
  });

  it("carries an existing database's rows and every column across the rebuild", async () => {
    await runMigrations(db, PRE_026);
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["Svc#run", "app/svc.rb", "Repo#find", "app/repo.rb", "repo.find", "dynamic", 0.5],
    );
    // A legacy NULL-edgeKind row — written before 006 — must survive verbatim too.
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      ["Old#call", "app/old.rb", "Legacy#m", "app/legacy.rb", "legacy.m"],
    );

    const result = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(result.applied).toContain(MIGRATION);
    const rows = await db.queryAll<{
      source_symbol_id: string;
      source_rel_path: string;
      target_symbol_id: string;
      target_rel_path: string;
      call_expression: string;
      edge_kind: string | null;
      confidence: number | null;
    }>("SELECT * FROM cg_symbols_edges_method ORDER BY source_symbol_id");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_symbol_id: "Old#call",
      source_rel_path: "app/old.rb",
      target_symbol_id: "Legacy#m",
      target_rel_path: "app/legacy.rb",
      call_expression: "legacy.m",
      edge_kind: null,
      confidence: null,
    });
    expect(rows[1]).toMatchObject({
      source_symbol_id: "Svc#run",
      source_rel_path: "app/svc.rb",
      target_symbol_id: "Repo#find",
      target_rel_path: "app/repo.rb",
      call_expression: "repo.find",
      edge_kind: "dynamic",
    });
    expect(rows[1].confidence).toBeCloseTo(0.5);
  });

  it("keeps legacy rows that differed only in target_symbol_id (same-file fan-out candidates survive)", async () => {
    // Two pins of the same call site to two different symbols are legal under
    // the old key (target_symbol_id was the distinguishing member) and are the
    // dispatch/interface fan-out shape (bd tea-rags-mcp-n0zj / t5cji). The
    // sentinel carries them across DISTINCT — collapsing them to the first
    // candidate would silently zero the second candidate's fan-in.
    await runMigrations(db, PRE_026);
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, 'exact', 1.0)`,
      ["Svc#run", "app/svc.rb", "Repo#find", "app/repo.rb", "repo.find"],
    );
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, 'exact', 1.0)`,
      ["Svc#run", "app/svc.rb", "Cache#find", "app/repo.rb", "repo.find"],
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    const rows = await db.queryAll<{ target_symbol_id: string | null }>(
      "SELECT target_symbol_id FROM cg_symbols_edges_method ORDER BY target_symbol_id",
    );
    expect(rows.map((r) => r.target_symbol_id)).toEqual(["Cache#find", "Repo#find"]);
  });

  it("still lands an identical edge only once across the rebuild (dedup preserved)", async () => {
    // The same edge written twice before the migration is ONE row, and stays
    // one — the sentinel is constant for identical upserts.
    await runMigrations(db, PRE_026);
    for (let i = 0; i < 2; i++) {
      await db.run(
        `INSERT OR IGNORE INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
         VALUES (?, ?, ?, ?, ?, 'exact', 1.0)`,
        ["Svc#run", "app/svc.rb", "Repo#find", "app/repo.rb", "repo.find"],
      );
    }

    await runMigrations(db, DATABASE_MIGRATIONS);

    const rows = await db.queryAll<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM cg_symbols_edges_method");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("keeps two rows that differ only in target_rel_path (the new disambiguator)", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    for (const targetPath of ["app/one.ts", "app/two.ts"]) {
      await db.run(
        `INSERT INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, target_symbol_key, edge_kind, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 'exact', 1.0)`,
        ["Svc#run", "app/svc.rb", `Target#${targetPath}`, targetPath, "handler.on()", `Target#${targetPath}`],
      );
    }

    const rows = await db.queryAll<{ target_rel_path: string }>(
      "SELECT target_rel_path FROM cg_symbols_edges_method ORDER BY target_rel_path",
    );
    expect(rows.map((r) => r.target_rel_path)).toEqual(["app/one.ts", "app/two.ts"]);
  });

  it("recreates exactly the three secondary indexes the table earns", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Same three 019 measured as earning their drift exposure — a rebuild that
    // silently dropped them would undo that measurement.
    expect(await indexesOn("cg_symbols_edges_method")).toEqual([
      "idx_cg_symbols_edges_method_source_rel_path",
      "idx_cg_symbols_edges_method_target_rel_path",
      "idx_cg_symbols_edges_method_target_symbol",
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });
});
