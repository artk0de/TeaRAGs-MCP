import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "064-cg-residual-schema-attributes.sql";

describe("064 records schema-column answers of the residual pass", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-schema-attr-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after the external sites and the run stats it extends", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("058-cg-residual-external-sites.sql"));
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("057-cg-run-stats-narrowed.sql"));
  });

  it("reads an external site written without an outcome as external, and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      "INSERT INTO cg_residual_external_sites (model, source_rel_path, site_key, menu_hash, p) VALUES ('kev', 'a.rb', 'k1', 'm', 0.9)",
    );

    expect(await db.queryAll("SELECT outcome FROM cg_residual_external_sites")).toEqual([{ outcome: "external" }]);
  });

  it("backfills schema_attribute as 0 on the run breakdown and the per-file tally", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      "INSERT INTO cg_run_stats (language, receiver_kind, attempted, resolved) VALUES ('ruby', 'dynamic', 3, 1)",
    );
    await db.run(
      "INSERT INTO cg_file_resolve_stats (rel_path, language, receiver_kind, attempted, resolved) VALUES ('a.rb', 'ruby', 'dynamic', 3, 1)",
    );

    const [run] = await db.queryAll<{ schema_attribute: number | bigint }>("SELECT schema_attribute FROM cg_run_stats");
    const [file] = await db.queryAll<{ schema_attribute: number | bigint }>(
      "SELECT schema_attribute FROM cg_file_resolve_stats",
    );
    expect(Number(run.schema_attribute)).toBe(0);
    expect(Number(file.schema_attribute)).toBe(0);
  });
});
