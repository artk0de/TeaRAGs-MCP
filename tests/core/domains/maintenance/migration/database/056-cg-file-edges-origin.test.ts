import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "056-cg-file-edges-origin.sql";
const BEFORE_056 = DATABASE_MIGRATIONS.slice(
  0,
  DATABASE_MIGRATIONS.findIndex((m) => m.filename === MIGRATION),
);

describe("056 marks model-derived file edges", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-edge-origin-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after the method-edge provenance it builds on", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("054-cg-method-edges-origin.sql"));
  });

  it("adds a nullable VARCHAR origin column", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const cols = await db.queryAll<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'cg_symbols_edges_file' AND column_name = 'origin'`,
    );
    expect(cols).toEqual([{ data_type: "VARCHAR", is_nullable: "YES" }]);
  });

  it("keeps an import edge written before it, reading its origin as NULL", async () => {
    await runMigrations(db, BEFORE_056);
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES ('a.ts', 'b.ts', './b')",
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    expect(await db.queryAll("SELECT origin FROM cg_symbols_edges_file")).toEqual([{ origin: null }]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.skipped).toContain(MIGRATION);
  });
});
