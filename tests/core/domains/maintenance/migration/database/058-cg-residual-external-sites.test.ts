import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "058-cg-residual-external-sites.sql";

describe("058 stores the residual sites a model put outside the project", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-external-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after the residual call sites it is read against", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("055-cg-residual-call-sites-receiver.sql"));
  });

  it("creates the table keyed by model, path and site", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cg_residual_external_sites' ORDER BY ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["model", "source_rel_path", "site_key", "menu_hash", "p"]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).not.toContain(MIGRATION);
  });
});
