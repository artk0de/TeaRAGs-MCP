import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "032-cg-symbols-files-type-abstractness.sql";
const PRE_032 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-r8hme.8 — `cg_symbols_files` gains the file's
 * type-abstractness census. Nullable with no default: a row written before the
 * census never measured its types, and NULL is what says so.
 */
describe("032 adds the type-abstractness census to cg_symbols_files", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-files-census-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 031", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("031-cg-temporal-init.sql") + 1);
  });

  it("keeps legacy rows and reads their census back as NULL", async () => {
    await runMigrations(db, PRE_032);
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('a.rb', 'ruby')");

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(
      await db.queryAll("SELECT rel_path, abstract_type_count, concrete_type_count FROM cg_symbols_files"),
    ).toEqual([{ rel_path: "a.rb", abstract_type_count: null, concrete_type_count: null }]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
