import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "045-cg-temporal-bundle-task-ids.sql";

/**
 * bd tea-rags-mcp-09c4m — each admitted co-change bundle records the task ids
 * its commit message names, so shotgun surgery can join one author burst's
 * commits into one logical change.
 */
describe("045 adds the co-change bundle task-id column", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-task-ids-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 044", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("044-cg-temporal-bursts.sql") + 1);
  });

  it("keeps a row written before it, reading the new column as unknown", async () => {
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION),
    );
    await db.run("INSERT INTO cg_temporal_bundle_commits (bundle_id, commit_shas, burst_id) VALUES (0, '[\"s1\"]', 0)");

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [bundle] = await db.queryAll<{ task_ids: string | null }>("SELECT task_ids FROM cg_temporal_bundle_commits");
    expect(bundle.task_ids).toBeNull();
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
