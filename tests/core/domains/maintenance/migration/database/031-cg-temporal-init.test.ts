import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "031-cg-temporal-init.sql";

/**
 * bd tea-rags-mcp-x4rpp — the temporal co-change sub-graph gets its own
 * `cg_temporal_*` tables beside `cg_symbols_*`: per-file occurrence counts,
 * undirected co-change pairs, and the single provenance row the builder
 * compares against HEAD.
 */
describe("031 creates the cg_temporal tables", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 030", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("030-cg-file-edge-export-names.sql") + 1);
  });

  it("creates the three tables with their keys", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    await db.run(
      "INSERT INTO cg_temporal_files (rel_path, bundle_count, partner_count, last_changed_at) VALUES ('a.ts', 3, 1, 10)",
    );
    await db.run(
      `INSERT INTO cg_temporal_edges_cochange
         (rel_path_a, rel_path_b, support, confidence_ab, confidence_ba, lift, last_co_change_at, sample_commits)
       VALUES ('a.ts', 'b.ts', 2, 0.5, 1.0, 4.0, 10, '["s1","s2"]')`,
    );
    await db.run(
      `INSERT INTO cg_temporal_meta
         (meta_key, head, fingerprint, built_at, window_since, commit_count, bundle_count, admitted_bundle_count,
          max_files_per_bundle, min_support, max_partners_per_file, session_gap_minutes)
       VALUES ('cochange', 'h', 'f', 1, 0, 5, 5, 4, 12, 2, 20, NULL)`,
    );

    await expect(
      db.run(
        `INSERT INTO cg_temporal_edges_cochange
           (rel_path_a, rel_path_b, support, confidence_ab, confidence_ba, lift, last_co_change_at, sample_commits)
         VALUES ('a.ts', 'b.ts', 9, 0.5, 1.0, 4.0, 10, '[]')`,
      ),
    ).rejects.toThrow();
    expect(await db.queryAll("SELECT rel_path, bundle_count FROM cg_temporal_files")).toEqual([
      { rel_path: "a.ts", bundle_count: 3 },
    ]);
    expect(await db.queryAll("SELECT session_gap_minutes FROM cg_temporal_meta")).toEqual([
      { session_gap_minutes: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await expect(runMigrations(db, DATABASE_MIGRATIONS)).resolves.not.toThrow();
  });
});
