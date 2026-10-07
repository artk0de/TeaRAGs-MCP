import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "044-cg-temporal-bursts.sql";

/**
 * bd tea-rags-mcp-3vg0x — co-change bundles are per commit and counted once
 * per author burst: each admitted bundle records its burst, and the meta row
 * records N in bursts and the burst window the build derived.
 */
describe("044 adds the co-change burst columns", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-bursts-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 043", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("043-cg-temporal-bundle-commits.sql") + 1);
  });

  it("keeps a row written before it, reading the new columns as unknown", async () => {
    const before = DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION);
    await runMigrations(db, before);
    await db.run("INSERT INTO cg_temporal_bundle_commits (bundle_id, commit_shas) VALUES (0, '[\"s1\"]')");
    await db.run(
      `INSERT INTO cg_temporal_meta
         (meta_key, head, fingerprint, built_at, window_since, commit_count, bundle_count, admitted_bundle_count,
          max_files_per_bundle, min_support, max_partners_per_file, session_gap_minutes)
       VALUES ('cochange', 'h', 'f', 1, 0, 5, 5, 4, 12, 2, 20, NULL)`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [bundle] = await db.queryAll<{ burst_id: number | null }>("SELECT burst_id FROM cg_temporal_bundle_commits");
    expect(bundle.burst_id).toBeNull();
    const [meta] = await db.queryAll<Record<string, unknown>>(
      "SELECT admitted_burst_count, burst_window_minutes, burst_window_method FROM cg_temporal_meta",
    );
    expect(meta).toEqual({ admitted_burst_count: null, burst_window_minutes: null, burst_window_method: null });
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
