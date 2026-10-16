import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "055-cg-residual-call-sites-receiver.sql";
const BEFORE_055 = DATABASE_MIGRATIONS.slice(
  0,
  DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
);

describe("055 adds language and receiver kind to residual call sites", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-receiver-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 054", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("054-cg-method-edges-origin.sql") + 1);
  });

  it("adds two nullable VARCHAR columns", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_residual_call_sites' AND column_name IN ('language', 'receiver_kind')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: "language", data_type: "VARCHAR", is_nullable: "YES" },
      { column_name: "receiver_kind", data_type: "VARCHAR", is_nullable: "YES" },
    ]);
  });

  it("keeps a residual row of a file it has no language for, reading both new columns as NULL", async () => {
    await runMigrations(db, BEFORE_055);
    await db.run(
      `INSERT INTO cg_residual_call_sites
         (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
          receiver_text, member, kind, candidates, menu_hash, menu_overflow)
       VALUES ('a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'account', 'users', 'dynamic', '["Firm#users"]', 'h', false)`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const rows = await db.queryAll<{ site_key: string; language: string | null; receiver_kind: string | null }>(
      "SELECT site_key, language, receiver_kind FROM cg_residual_call_sites",
    );
    expect(rows).toEqual([{ site_key: "k1", language: null, receiver_kind: null }]);
  });

  it("labels a row written before it with its file's language, leaving the receiver kind NULL", async () => {
    await runMigrations(db, BEFORE_055);
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('a.rb', 'ruby')");
    await db.run(
      `INSERT INTO cg_residual_call_sites
         (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
          receiver_text, member, kind, candidates, menu_hash, menu_overflow)
       VALUES ('a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'account', 'users', 'dynamic', '["Firm#users"]', 'h', false),
              ('gone.rb', 'k2', 'B#run', 1, 9, 3, 4, 'account', 'users', 'dynamic', '["Firm#users"]', 'h', false)`,
    );

    await runMigrations(db, DATABASE_MIGRATIONS);

    const rows = await db.queryAll<{ site_key: string; language: string | null; receiver_kind: string | null }>(
      "SELECT site_key, language, receiver_kind FROM cg_residual_call_sites ORDER BY site_key",
    );
    expect(rows).toEqual([
      { site_key: "k1", language: "ruby", receiver_kind: null },
      { site_key: "k2", language: null, receiver_kind: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });
});
