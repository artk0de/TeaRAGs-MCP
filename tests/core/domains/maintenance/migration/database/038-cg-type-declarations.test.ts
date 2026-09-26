import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "038-cg-type-declarations.sql";

/**
 * bd tea-rags-mcp-vi0wx / l2pkp (spec §1b) — `cg_type_declarations` holds every
 * type-level declaration each language's walker publishes, the single source
 * the naming lexicon's type roles read. 037 is reserved by another branch
 * (cg-cluster), so here 038 follows 036 directly.
 */
describe("038 creates cg_type_declarations", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-decl-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 037", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("037-cg-type-only-file-edges.sql") + 1);
  });

  it("creates the table with the spec's columns and types", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const cols = await db.queryAll<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'cg_type_declarations' ORDER BY ordinal_position`,
    );
    expect(cols).toEqual([
      { column_name: "rel_path", data_type: "VARCHAR" },
      { column_name: "language", data_type: "VARCHAR" },
      { column_name: "type_id", data_type: "VARCHAR" },
      { column_name: "short_name", data_type: "VARCHAR" },
      { column_name: "symbol_kind", data_type: "VARCHAR" },
      { column_name: "line", data_type: "INTEGER" },
      { column_name: "reopens", data_type: "BOOLEAN" },
      { column_name: "supertypes", data_type: "VARCHAR[]" },
    ]);
  });

  it("stores a supertype list and reads it back as a list", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      `INSERT INTO cg_type_declarations VALUES ('a.swift', 'swift', 'A.B', 'B', 'class', 3, false, ['Base', 'Named'])`,
    );
    expect(await db.queryAll("SELECT type_id, supertypes FROM cg_type_declarations")).toEqual([
      { type_id: "A.B", supertypes: ["Base", "Named"] },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
