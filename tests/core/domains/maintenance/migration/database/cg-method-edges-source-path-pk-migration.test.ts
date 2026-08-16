import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "020-cg-method-edges-source-path-pk.sql";

/**
 * bd tea-rags-mcp-ex28m — `cg_symbols_edges_method` was keyed
 * `(source_symbol_id, call_expression, target_symbol_id)`, with no
 * `source_rel_path`.
 *
 * A symbolId is unique per FILE, not per repository: top-level declarations get
 * a bare id, so three `BaseTable` files share one. Two of them calling the same
 * target through the same expression produced the SAME primary key, and the
 * write path's `INSERT OR IGNORE` dropped the second — first file wins, the
 * other file's edge never exists. No error, at any layer.
 *
 * The read-side file scoping (bd tea-rags-mcp-oxnvl) cannot see those rows: they
 * were never written. Extending the key is what lets them be.
 */
describe("020 extends the method-edge primary key with source_rel_path", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-pk-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function indexesOn(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = ? ORDER BY index_name",
      [table],
    );
    return rows.map((r) => r.index_name);
  }

  async function primaryKeyColumns(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ constraint_column_names: string[] }>(
      "SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
      [table],
    );
    return rows[0]?.constraint_column_names ?? [];
  }

  /** The collision shape: same symbolId + same call expression + same target, two files. */
  const NAMESAKE_ROWS: [string, string, string, string, string][] = [
    ["BaseTable", "ui/BaseTable.tsx", "renderRow", "shared/row.tsx", "renderRow"],
    ["BaseTable", "admin/BaseTable.tsx", "renderRow", "shared/row.tsx", "renderRow"],
  ];

  async function insertNamesakeRows(): Promise<void> {
    for (const [source, sourcePath, target, targetPath, call] of NAMESAKE_ROWS) {
      await db.run(
        `INSERT OR IGNORE INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
         VALUES (?, ?, ?, ?, ?, 'exact', 1.0)`,
        [source, sourcePath, target, targetPath, call],
      );
    }
  }

  async function edgeCount(): Promise<number> {
    const rows = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = 'BaseTable'",
    );
    return Number(rows[0].n);
  }

  it("leads the key with source_symbol_id so getCalleeEdges-shape lookups keep their PK prefix", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Order is load-bearing, not cosmetic: `WHERE source_symbol_id IN (...)` is
    // the frontier-expansion predicate, and it can only use the key as a prefix.
    expect(await primaryKeyColumns("cg_symbols_edges_method")).toEqual([
      "source_symbol_id",
      "source_rel_path",
      "call_expression",
      "target_symbol_id",
    ]);
  });

  it("persists both namesakes' edges instead of collapsing them to one", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    await insertNamesakeRows();

    expect(await edgeCount()).toBe(2);
  });

  it("NON-VACUITY: the same two rows collapse to one under the pre-020 key", async () => {
    const legacy = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);
    await runMigrations(db, legacy);

    await insertNamesakeRows();

    // This is the defect, reproduced: the admin namesake's edge is gone.
    expect(await edgeCount()).toBe(1);
  });

  it("carries an existing database's rows and every column across the rebuild", async () => {
    const legacy = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);
    await runMigrations(db, legacy);
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

  it("recreates exactly the secondary indexes 019 measured as earning their keep", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // 019 kept all three of this table's indexes (a getCallers-shape read is
    // 0.24ms indexed against 1.68ms scanned on 1.58M rows) — a table rebuild
    // that silently dropped them would undo that measurement.
    expect(await indexesOn("cg_symbols_edges_method")).toEqual([
      "idx_cg_symbols_edges_method_source_rel_path",
      "idx_cg_symbols_edges_method_target_rel_path",
      "idx_cg_symbols_edges_method_target_symbol",
    ]);
  });

  it("leaves target_symbol_id nullability exactly where the old key left it", async () => {
    // `target_symbol_id` is DECLARED nullable but has always been a PK member,
    // and DuckDB makes every PK column NOT NULL — so an unresolved call site was
    // never insertable, before this migration or after. Verified against BOTH
    // schemas rather than assumed: the rebuild must not quietly change this, in
    // either direction. It is also why the readers' `target_symbol_id IS NOT
    // NULL` filters match nothing to exclude in practice.
    const insertNullTarget = async (): Promise<string> => {
      try {
        await db.run(
          `INSERT INTO cg_symbols_edges_method
             (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
           VALUES (?, ?, NULL, ?, ?, 'exact', 1.0)`,
          ["Svc#run", "app/svc.rb", "app/svc.rb", "mystery.call"],
        );
        return "accepted";
      } catch (err) {
        return (err as Error).message;
      }
    };

    const legacy = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);
    await runMigrations(db, legacy);
    const before = await insertNullTarget();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const after = await insertNullTarget();

    expect(before).toContain("NOT NULL constraint failed");
    expect(after).toBe(before);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });

  it("still replaces one file's edges wholesale without touching its namesake's", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await insertNamesakeRows();

    // The per-file lifecycle is scoped by source_rel_path and must stay that way:
    // re-walking ui/BaseTable.tsx may not disturb admin/BaseTable.tsx.
    await db.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?", ["ui/BaseTable.tsx"]);

    const rows = await db.queryAll<{ source_rel_path: string }>(
      "SELECT source_rel_path FROM cg_symbols_edges_method ORDER BY source_rel_path",
    );
    expect(rows.map((r) => r.source_rel_path)).toEqual(["admin/BaseTable.tsx"]);
  });
});
