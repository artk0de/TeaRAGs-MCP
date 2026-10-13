import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "049-cg-symbols-edges-field.sql";
const THROUGH_049 = DATABASE_MIGRATIONS.slice(0, DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION) + 1);

/**
 * bd tea-rags-mcp-zy6hx (D0) — `cg_symbols_edges_field` records which methods
 * read or write which fields: the data-dependency relation the call and import
 * edge tables cannot express.
 */
describe("049 creates cg_symbols_edges_field", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edges-field-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 048", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("048-cg-drop-legacy-review-edge-tables.ts") + 1);
  });

  it("creates the table with the decided columns and types", async () => {
    await runMigrations(db, THROUGH_049);
    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_symbols_edges_field' ORDER BY ordinal_position`,
    );
    expect(cols).toEqual([
      { column_name: "source_rel_path", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "source_symbol_id", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "owner_kind", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "owner_type", data_type: "VARCHAR", is_nullable: "YES" },
      { column_name: "receiver", data_type: "VARCHAR", is_nullable: "YES" },
      { column_name: "field_name", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "access_kind", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "access_count", data_type: "INTEGER", is_nullable: "NO" },
      { column_name: "first_line", data_type: "INTEGER", is_nullable: "YES" },
    ]);
  });

  it("carries no index, so a per-file rewrite leaves no dead row versions", async () => {
    await runMigrations(db, THROUGH_049);
    const indexes = await db.queryAll(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols_edges_field'",
    );
    const constraints = await db.queryAll(
      `SELECT constraint_type FROM duckdb_constraints()
        WHERE table_name = 'cg_symbols_edges_field' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`,
    );
    expect(indexes).toEqual([]);
    expect(constraints).toEqual([]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
