import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "034-cg-identifiers-type-multiplicity.sql";
const PRE_034 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-4p3sb.26 — `cg_identifiers` gains the multiplicity of the
 * declared type: a `candidates: Doc[]` row and a `fallback: Doc` row both name
 * `Doc`, and only this column tells the collection from the element. Defaulted
 * to `one`, so a row written before the column reads as it always did.
 */
describe("034 adds type_multiplicity to cg_identifiers", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-ident-mult-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 033", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("033-cg-identifiers.sql") + 1);
  });

  it("keeps pre-existing rows and reads their multiplicity back as one", async () => {
    await runMigrations(db, PRE_034);
    await db.run(
      "INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, type_name, line) VALUES ('a.ts', 'f', 'param', 'doc', 'Doc', 1)",
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await db.queryAll("SELECT name, type_name, type_multiplicity FROM cg_identifiers")).toEqual([
      { name: "doc", type_name: "Doc", type_multiplicity: "one" },
    ]);
  });

  it("defaults a row inserted without the column to one", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      "INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, line) VALUES ('a.ts', 'f', 'local', 'x', 2)",
    );
    expect(await db.queryAll("SELECT type_multiplicity FROM cg_identifiers")).toEqual([{ type_multiplicity: "one" }]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
