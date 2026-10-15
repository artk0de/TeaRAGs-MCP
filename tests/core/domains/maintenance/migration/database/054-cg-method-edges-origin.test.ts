import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "054-cg-method-edges-origin.sql";
const BEFORE_054 = DATABASE_MIGRATIONS.slice(
  0,
  DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
);

describe("054 adds model-edge provenance to method edges", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-origin-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 053", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("053-cg-residual-call-sites.sql") + 1);
  });

  it("adds four nullable columns with their declared types", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_symbols_edges_method' AND column_name IN ('origin', 'model', 'p', 'site_key')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: "model", data_type: "VARCHAR", is_nullable: "YES" },
      { column_name: "origin", data_type: "VARCHAR", is_nullable: "YES" },
      { column_name: "p", data_type: "DOUBLE", is_nullable: "YES" },
      { column_name: "site_key", data_type: "VARCHAR", is_nullable: "YES" },
    ]);
  });

  it("keeps a static edge written before it, reading every new column as NULL", async () => {
    await runMigrations(db, BEFORE_054);
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key, target_symbol_id)
       VALUES ('A#run', 'a.rb', 'b.rb', 'b.go', 'B#go', 'B#go')`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const rows = await db.queryAll<{
      origin: string | null;
      model: string | null;
      p: number | null;
      site_key: string | null;
    }>("SELECT origin, model, p, site_key FROM cg_symbols_edges_method");
    expect(rows).toEqual([{ origin: null, model: null, p: null, site_key: null }]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });
});
