import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { REMOVED_FILE_SOURCE_TABLES } from "../../../../../../src/core/adapters/duckdb/file-graph-store.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "060-cg-caller-param-observations.sql";

describe("060 persists caller-parameter observations and the paramTyped counter", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-caller-param-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columnsOf = async (table: string): Promise<string[]> =>
    (
      await db.queryAll<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position`,
        [table],
      )
    ).map((c) => c.column_name);

  it("creates the observation table, one row per caller file", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await columnsOf("cg_caller_param_observations")).toEqual(["source_rel_path", "observations"]);
  });

  it("adds param_typed to the run breakdown and the per-file tally, defaulting to 0", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await columnsOf("cg_run_stats")).toContain("param_typed");
    expect(await columnsOf("cg_file_resolve_stats")).toContain("param_typed");
  });

  it("is part of the removed-file cascade", () => {
    expect(REMOVED_FILE_SOURCE_TABLES).toContain("cg_caller_param_observations");
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).not.toContain(MIGRATION);
  });
});
