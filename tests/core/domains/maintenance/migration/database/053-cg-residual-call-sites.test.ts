import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "053-cg-residual-call-sites.sql";

const INSERT = `INSERT INTO cg_residual_call_sites
  (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
   receiver_text, member, kind, candidates, menu_hash, menu_overflow)
  VALUES ('app/a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'account', 'users', 'dynamic', '["Firm#users"]', 'h', false)`;

describe("053 creates the residual call-site table", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-sites-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 052", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("052-cg-temporal-bundle-rename-sweep.sql") + 1);
  });

  it("keys on (source_rel_path, site_key), the per-file writer's scope first", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const rows = await db.queryAll<{ constraint_column_names: string[] }>(
      "SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = 'cg_residual_call_sites' AND constraint_type = 'PRIMARY KEY'",
    );
    expect(rows.map((r) => r.constraint_column_names)).toEqual([["source_rel_path", "site_key"]]);
  });

  it("stores one row per (file, site key) and rejects a duplicate", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(INSERT);

    const rows = await db.queryAll<{ kind: string; candidates: string; menu_overflow: boolean }>(
      "SELECT kind, candidates, menu_overflow FROM cg_residual_call_sites",
    );
    expect(rows).toEqual([{ kind: "dynamic", candidates: '["Firm#users"]', menu_overflow: false }]);
    await expect(db.run(INSERT)).rejects.toThrow();
  });

  it("indexes site_key for the pass's cross-file lookup", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_residual_call_sites'",
    );
    expect(rows.map((r) => r.index_name)).toEqual(["idx_cg_residual_call_sites_site_key"]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });
});
