import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "065-cg-residual-calibration.sql";

describe("065 stores the static site sample and the residual calibration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const columnsOf = async (table: string): Promise<string[]> =>
    (
      await db.queryAll<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position`,
        [table],
      )
    ).map((c) => c.column_name);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-calibration-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered right after 064", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("064-cg-residual-schema-attributes.sql") + 1);
  });

  it("creates the per-file static site sample", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await columnsOf("cg_static_site_sample")).toEqual([
      "source_rel_path",
      "site_key",
      "language",
      "method_symbol_id",
      "method_start_line",
      "method_end_line",
      "line",
      "call_column",
      "receiver_text",
      "receiver_kind",
      "member",
      "outcome",
      "target_symbol_id",
      "reason",
      "owners",
      "candidates",
      "menu_overflow",
      "priority",
    ]);
  });

  it("creates the calibration table keyed by language and stratum", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await columnsOf("cg_residual_calibration")).toEqual([
      "language",
      "stratum",
      "threshold",
      "lower_bound",
      "n",
      "pi",
      "none_rates",
      "model",
      "template_hash",
      "graph_fingerprint",
      "created_at",
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).not.toContain(MIGRATION);
  });
});
