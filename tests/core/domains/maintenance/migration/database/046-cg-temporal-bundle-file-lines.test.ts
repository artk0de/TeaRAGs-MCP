import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "046-cg-temporal-bundle-file-lines.sql";

/**
 * bd tea-rags-mcp-dm61n — each co-change bundle file row records the +/- line
 * counts its commit made to that file.
 */
describe("046 adds the co-change bundle file line-count columns", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-file-lines-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 045", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("045-cg-temporal-bundle-task-ids.sql") + 1);
  });

  it("keeps a row written before it, reading both new columns as unknown", async () => {
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION),
    );
    await db.run("INSERT INTO cg_temporal_bundle_files (bundle_id, rel_path) VALUES (0, 'a.ts')");

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const [row] = await db.queryAll<{ lines_added: number | null; lines_deleted: number | null }>(
      "SELECT lines_added, lines_deleted FROM cg_temporal_bundle_files",
    );
    expect(row).toEqual({ lines_added: null, lines_deleted: null });
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
