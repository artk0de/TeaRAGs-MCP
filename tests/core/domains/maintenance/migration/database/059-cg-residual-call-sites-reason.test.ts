import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "059-cg-residual-call-sites-reason.sql";
const BEFORE_059 = DATABASE_MIGRATIONS.slice(
  0,
  DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
);

describe("059 adds the routing reason to residual call sites", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-reason-mig-"));
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

  it("adds a nullable VARCHAR reason column", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_residual_call_sites' AND column_name = 'reason'`,
    );
    expect(cols).toEqual([{ column_name: "reason", data_type: "VARCHAR", is_nullable: "YES" }]);
  });

  it("keeps a row written before it, whose reason reads as absent", async () => {
    await runMigrations(db, BEFORE_059);
    await db.run(
      `INSERT INTO cg_residual_call_sites
         (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
          receiver_text, member, kind, candidates, menu_hash, menu_overflow)
       VALUES ('a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'record', 'with_lock', 'dynamic', '["Lockable#with_lock"]', 'h', false)`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [row] = await db.readResidualCallSites();
    expect(row?.siteKey).toBe("k1");
    expect(row).not.toHaveProperty("reason");
  });
});
