import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_035_CG_TYPE_ONLY_FILE_EDGES } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/035-cg-type-only-file-edges.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-r8hme.12 — type-only file dependencies live in their own
// table, keyed like `cg_symbols_edges_file`, so no runtime-graph reader sees them.
describe("035 cg type-only file edges migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-only-edges-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates cg_symbols_edges_file_type_only keyed by (source, target), and is idempotent", async () => {
    const first = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(first.applied).toContain("035-cg-type-only-file-edges.sql");
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.skipped).toContain("035-cg-type-only-file-edges.sql");

    const columns = await db.queryAll<{ column_name: string; is_nullable: boolean }>(
      "SELECT column_name, is_nullable FROM duckdb_columns() WHERE table_name = 'cg_symbols_edges_file_type_only'",
    );
    expect(Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]))).toEqual({
      source_rel_path: false,
      target_rel_path: false,
      import_text: true,
    });
    const constraints = await db.queryAll<{ constraint_type: string; constraint_column_names: string[] }>(
      "SELECT constraint_type, constraint_column_names FROM duckdb_constraints() WHERE table_name = 'cg_symbols_edges_file_type_only' AND constraint_type = 'PRIMARY KEY'",
    );
    expect(constraints.map((c) => c.constraint_column_names)).toEqual([["source_rel_path", "target_rel_path"]]);
  });

  it("is registered in DATABASE_MIGRATIONS with the .ts export as its sql", () => {
    const entry = DATABASE_MIGRATIONS.find((m) => m.filename === "035-cg-type-only-file-edges.sql");
    expect(entry?.sql).toBe(SQL_035_CG_TYPE_ONLY_FILE_EDGES);
  });
});
