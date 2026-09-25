import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "030-cg-file-edge-export-names.sql";
const PRE_030 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-r8hme.2 — `cg_symbols_edges_file` gains the export names a
 * file edge imports and re-exports. Nullable with no default: a row written
 * before the migration never recorded names, and NULL is what says so.
 */
describe("030 adds export-name columns to cg_symbols_edges_file", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-edge-names-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered as the next migration", () => {
    expect(DATABASE_MIGRATIONS.map((m) => m.filename)).toContain(MIGRATION);
  });

  it("keeps legacy rows and reads their names back as NULL", async () => {
    await runMigrations(db, PRE_030);
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES ('a.ts', 'b.ts', './b')",
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(
      await db.queryAll(
        "SELECT source_rel_path, target_rel_path, imported_export_names, reexported_export_names FROM cg_symbols_edges_file",
      ),
    ).toEqual([
      { source_rel_path: "a.ts", target_rel_path: "b.ts", imported_export_names: null, reexported_export_names: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
