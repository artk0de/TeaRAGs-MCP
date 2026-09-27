import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "040-cg-type-declarations-member-counts.sql";
const PRE_040 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-ffxfc — `cg_type_declarations` gains a declaration's member
 * census: how many of its members are methods and how many are fields.
 * Nullable with no default: a row written before the columns has no census,
 * and the naming read answers "unknown" for it rather than "no members".
 */
describe("040 adds method_count and field_count to cg_type_declarations", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-members-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 039", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("039-cg-hierarchy-dependencies.sql") + 1);
  });

  it("adds two nullable INTEGER columns", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_type_declarations' AND column_name IN ('method_count', 'field_count')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: "field_count", data_type: "INTEGER", is_nullable: "YES" },
      { column_name: "method_count", data_type: "INTEGER", is_nullable: "YES" },
    ]);
  });

  it("keeps pre-existing rows and reads their census back as NULL", async () => {
    await runMigrations(db, PRE_040);
    await db.run("INSERT INTO cg_type_declarations VALUES ('a.ts', 'typescript', 'A', 'A', 'class', 1, false, [])");

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await db.queryAll("SELECT type_id, method_count, field_count FROM cg_type_declarations")).toEqual([
      { type_id: "A", method_count: null, field_count: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
