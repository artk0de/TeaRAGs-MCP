import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "048-cg-drop-legacy-review-edge-tables.ts";
/** The schema 048 leaves — later migrations add tables of their own, which this suite does not judge. */
const THROUGH_048 = DATABASE_MIGRATIONS.slice(0, DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION) + 1);

/**
 * bd tea-rags-mcp-bdnfu — builds older than bd xi2r9 D4 created one PERSISTENT
 * `cg_review_file_edges_<reviewId>` table per review in the database file. Their
 * only remover (the review-edge store's sweep) is gone, so 048 drops whatever
 * such tables a database still carries.
 */
describe("048 drops legacy persistent review edge tables", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-review-edge-drop-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION),
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function mainTables(): Promise<string[]> {
    const rows = await db.queryAll<{ table_name: string }>(
      "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main' AND NOT temporary " +
        "AND database_name = current_database() ORDER BY table_name",
    );
    return rows.map((r) => r.table_name);
  }

  it("is registered after 047", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("047-cg-temporal-bundle-committed-at.sql") + 1);
  });

  it("drops every cg_review_file_edges_* table and keeps the rest", async () => {
    await db.exec(
      'CREATE TABLE "cg_review_file_edges_1700000000-123-abc123" (source_rel_path VARCHAR, target_rel_path VARCHAR)',
    );
    await db.exec(
      'CREATE TABLE "cg_review_file_edges_1700000999-4567-zz9zz9" (source_rel_path VARCHAR, target_rel_path VARCHAR)',
    );
    await db.exec("CREATE TABLE cg_review_unrelated (id INTEGER)");
    const before = await mainTables();

    const outcome = await runMigrations(db, THROUGH_048);

    expect(outcome.applied).toEqual([MIGRATION]);
    const after = await mainTables();
    expect(after.filter((t) => t.startsWith("cg_review_file_edges_"))).toEqual([]);
    expect(after).toContain("cg_review_unrelated");
    expect(after).toEqual(before.filter((t) => !t.startsWith("cg_review_file_edges_")));
    const ledger = await db.queryAll<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = ?",
      [MIGRATION],
    );
    expect(ledger).toHaveLength(1);
  });

  it("is a no-op on a database that carries none", async () => {
    const before = await mainTables();

    const outcome = await runMigrations(db, THROUGH_048);

    expect(outcome.applied).toEqual([MIGRATION]);
    expect(await mainTables()).toEqual(before);
  });
});
