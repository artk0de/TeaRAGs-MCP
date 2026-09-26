import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "036-cg-identifiers-call-unwrap.sql";
const PRE_036 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-bjzaf — `cg_identifiers` gains the two facts the call-return
 * join needs to tell `let doc = load()?` from `let attempt = load()`: whether a
 * local's bound call was consumed through `?` / `await`, and which wrapper
 * (`Result`, `Promise`) a return type was read through. Nullable with no
 * default: a row written before the columns carries neither fact, and the join
 * reads NULL exactly as it read the row before.
 */
describe("036 adds bound_call_unwrapped and return_wrapper to cg_identifiers", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-ident-unwrap-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 035", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("035-cg-symbols-symbol-kind.sql") + 1);
  });

  it("adds a nullable BOOLEAN and a nullable VARCHAR column", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_identifiers' AND column_name IN ('bound_call_unwrapped', 'return_wrapper')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: "bound_call_unwrapped", data_type: "BOOLEAN", is_nullable: "YES" },
      { column_name: "return_wrapper", data_type: "VARCHAR", is_nullable: "YES" },
    ]);
  });

  it("keeps pre-existing rows and reads both facts back as NULL", async () => {
    await runMigrations(db, PRE_036);
    await db.run(
      "INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, line, bound_member) VALUES ('a.rs', 'run', 'local', 'doc', 2, 'load')",
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await db.queryAll("SELECT name, bound_call_unwrapped, return_wrapper FROM cg_identifiers")).toEqual([
      { name: "doc", bound_call_unwrapped: null, return_wrapper: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
