import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "063-cg-residual-class-sets.sql";
const BEFORE_063 = DATABASE_MIGRATIONS.slice(
  0,
  DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
);

describe("063 adds the shared class-set table and the row reference to it", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-class-sets-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered", () => {
    expect(DATABASE_MIGRATIONS.map((m) => m.filename)).toContain(MIGRATION);
  });

  it("adds a nullable VARCHAR class_set column and the cg_residual_class_sets table keyed by set_key", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE (table_name = 'cg_residual_call_sites' AND column_name = 'class_set')
           OR table_name = 'cg_residual_class_sets'
        ORDER BY table_name, column_name`,
    );
    expect(cols).toEqual([
      { table_name: "cg_residual_call_sites", column_name: "class_set", data_type: "VARCHAR", is_nullable: "YES" },
      { table_name: "cg_residual_class_sets", column_name: "class_targets", data_type: "VARCHAR", is_nullable: "NO" },
      { table_name: "cg_residual_class_sets", column_name: "set_key", data_type: "VARCHAR", is_nullable: "NO" },
    ]);
  });

  it("keeps a row written before it, its class targets read from the row", async () => {
    await runMigrations(db, BEFORE_063);
    await db.run(
      `INSERT INTO cg_residual_call_sites
         (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
          receiver_text, member, kind, candidates, menu_hash, menu_overflow, receiver_group, class_targets)
       VALUES ('a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'record', 'with_lock', 'dynamic', '["Lockable#with_lock"]', 'h', false,
               'g', '[["Lockable"],["Account","Base#with_lock","Firm"]]')`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [row] = await db.readResidualCallSites();
    expect(row?.siteKey).toBe("k1");
    expect(row?.classTargets).toEqual([
      ["Lockable", "Lockable#with_lock"],
      ["Account", "Base#with_lock", "Firm"],
    ]);
  });
});
