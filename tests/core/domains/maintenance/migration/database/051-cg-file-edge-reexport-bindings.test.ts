import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_051_CG_FILE_EDGE_REEXPORT_BINDINGS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/051-cg-file-edge-reexport-bindings.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "051-cg-file-edge-reexport-bindings.sql";
const THROUGH_051 = DATABASE_MIGRATIONS.slice(0, DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION) + 1);

/**
 * bd tea-rags-mcp-zl3so — `cg_symbols_edges_file.reexported_export_bindings`:
 * the exposed → forwarded name table of an aliased re-export. Nullable: NULL is
 * "no alias recorded", and every reader then takes the source names as exposed.
 */
describe("051 adds cg_symbols_edges_file.reexported_export_bindings", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-reexport-bindings-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 050", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("050-cg-type-declarations-async-method-count.sql") + 1);
  });

  it("adds a nullable VARCHAR column, and a row written before it reads NULL", async () => {
    const before = DATABASE_MIGRATIONS.slice(
      0,
      DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
    );
    await runMigrations(db, before);
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, reexported_export_names) VALUES ('src/index.ts', 'src/a.ts', 'a')",
    );
    await runMigrations(db, THROUGH_051);
    const cols = await db.queryAll<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_symbols_edges_file' AND column_name = 'reexported_export_bindings'`,
    );
    expect(cols).toEqual([{ data_type: "VARCHAR", is_nullable: "YES" }]);
    expect(await db.queryAll("SELECT reexported_export_bindings FROM cg_symbols_edges_file")).toEqual([
      { reexported_export_bindings: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, THROUGH_051);
    await db.run(SQL_051_CG_FILE_EDGE_REEXPORT_BINDINGS);
    const cols = await db.queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_symbols_edges_file' AND column_name = 'reexported_export_bindings'",
    );
    expect(cols).toHaveLength(1);
  });
});
