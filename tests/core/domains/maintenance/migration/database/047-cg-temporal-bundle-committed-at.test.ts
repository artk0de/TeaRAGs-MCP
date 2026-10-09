import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "047-cg-temporal-bundle-committed-at.sql";

/**
 * bd tea-rags-mcp-zf9yz — each co-change bundle commit row records its commit
 * time, the chronology shotgun surgery's lifecycle test orients by.
 */
describe("047 adds the co-change bundle commit-time column", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-committed-at-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 046", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("046-cg-temporal-bundle-file-lines.sql") + 1);
  });

  it("keeps a row written before it, reading its commit time as unknown", async () => {
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION),
    );
    await db.run("INSERT INTO cg_temporal_bundle_commits (bundle_id, commit_shas) VALUES (0, '[\"s1\"]')");

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [row] = await db.queryAll<{ committed_at: number | null }>(
      "SELECT committed_at FROM cg_temporal_bundle_commits",
    );
    expect(row).toEqual({ committed_at: null });
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
