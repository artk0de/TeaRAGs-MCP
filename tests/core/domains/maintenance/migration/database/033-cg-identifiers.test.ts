import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_033_CG_IDENTIFIERS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/033-cg-identifiers.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-4p3sb.8 — identifier declarations for the naming lexicon. No
// key and no secondary index: rows are replaced per file and read by GROUP BY,
// and a table without an index is the one DuckDB vacuums deletes of at
// checkpoint (bd tea-rags-mcp-dvzdm).
describe("033 cg identifiers migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-identifiers-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates cg_identifiers with its columns, no index, and is idempotent", async () => {
    const first = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(first.applied).toContain("033-cg-identifiers.sql");
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.skipped).toContain("033-cg-identifiers.sql");

    const columns = await db.queryAll<{ column_name: string; is_nullable: boolean }>(
      "SELECT column_name, is_nullable FROM duckdb_columns() WHERE table_name = 'cg_identifiers'",
    );
    expect(Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]))).toEqual({
      rel_path: false,
      owner_symbol_id: false,
      kind: false,
      name: false,
      type_name: true,
      type_source: true,
      line: false,
      bound_member: true,
      bound_receiver: true,
      bound_call_expression: true,
      // Added by 034 (bd tea-rags-mcp-4p3sb.26); DuckDB refuses NOT NULL on an added column.
      type_multiplicity: true,
      // Added by 036 (bd tea-rags-mcp-bjzaf): the call-return join's unwrap facts.
      bound_call_unwrapped: true,
      return_wrapper: true,
    });
    const indexes = await db.queryAll("SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_identifiers'");
    expect(indexes).toEqual([]);
    const constraints = await db.queryAll<{ constraint_type: string }>(
      "SELECT constraint_type FROM duckdb_constraints() WHERE table_name = 'cg_identifiers'",
    );
    expect(constraints.map((c) => c.constraint_type)).not.toContain("PRIMARY KEY");
  });

  it("is registered in DATABASE_MIGRATIONS with the .ts export as its sql", () => {
    const entry = DATABASE_MIGRATIONS.find((m) => m.filename === "033-cg-identifiers.sql");
    expect(entry?.sql).toBe(SQL_033_CG_IDENTIFIERS);
  });
});
