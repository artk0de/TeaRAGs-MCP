import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";

describe("005 cg_symbols_inheritance migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-inh-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the table with the expected columns and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("005-cg-symbols-inheritance.sql");
    expect(second.skipped).toContain("005-cg-symbols-inheritance.sql");

    const cols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_symbols_inheritance'",
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      [
        "ancestor_fq_name",
        "ancestor_symbol_id",
        "kind",
        "ordinal",
        "source_fq_name",
        "source_rel_path",
        "source_symbol_id",
      ].sort(),
    );
  });
});
