import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_050_CG_TYPE_DECLARATIONS_ASYNC_METHOD_COUNT } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/050-cg-type-declarations-async-method-count.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "050-cg-type-declarations-async-method-count.sql";
const THROUGH_050 = DATABASE_MIGRATIONS.slice(0, DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION) + 1);

/**
 * bd tea-rags-mcp-ek2cu — `cg_type_declarations.async_method_count`: a class's
 * async instance methods, the fact separating an operations facade from a
 * computational model in one directory. Nullable: NULL is "unknown".
 */
describe("050 adds cg_type_declarations.async_method_count", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-async-count-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 049", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("049-cg-symbols-edges-field.sql") + 1);
  });

  it("adds a nullable INTEGER column, and a row written before it reads NULL", async () => {
    const before = DATABASE_MIGRATIONS.slice(
      0,
      DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
    );
    await runMigrations(db, before);
    await db.run(
      "INSERT INTO cg_type_declarations (rel_path, language, type_id, short_name, symbol_kind, line, reopens, supertypes) VALUES ('src/a.ts', 'typescript', 'A', 'A', 'class', 1, false, [])",
    );
    await runMigrations(db, THROUGH_050);
    const cols = await db.queryAll<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_type_declarations' AND column_name = 'async_method_count'`,
    );
    expect(cols).toEqual([{ data_type: "INTEGER", is_nullable: "YES" }]);
    expect(await db.queryAll("SELECT async_method_count FROM cg_type_declarations")).toEqual([
      { async_method_count: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, THROUGH_050);
    await db.run(SQL_050_CG_TYPE_DECLARATIONS_ASYNC_METHOD_COUNT);
    const cols = await db.queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_type_declarations' AND column_name = 'async_method_count'",
    );
    expect(cols).toHaveLength(1);
  });
});
