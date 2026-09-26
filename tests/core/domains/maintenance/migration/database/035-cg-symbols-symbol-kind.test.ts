import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "035-cg-symbols-symbol-kind.sql";
const PRE_035 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-vi0wx — `cg_symbols` gains the declaration kind the walker
 * saw (class, module, interface, …), so type-name judgement can tell a type
 * from a function. Nullable with no default: a row written before the column
 * carries no such fact, and NULL reads as "unknown", never as a guessed kind.
 */
describe("035 adds symbol_kind to cg_symbols", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-kind-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 034", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("034-cg-identifiers-type-multiplicity.sql") + 1);
  });

  it("adds a nullable VARCHAR column", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'cg_symbols' AND column_name = 'symbol_kind'",
    );
    expect(cols).toEqual([{ column_name: "symbol_kind", data_type: "VARCHAR", is_nullable: "YES" }]);
  });

  it("keeps pre-existing rows and reads their kind back as NULL", async () => {
    await runMigrations(db, PRE_035);
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES ('a.ts', 'Foo', 'Foo', 'Foo', '[]')",
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await db.queryAll("SELECT symbol_id, symbol_kind FROM cg_symbols")).toEqual([
      { symbol_id: "Foo", symbol_kind: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
