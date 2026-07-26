import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-f2jsb / j0pki — over-cap dynamic fan-outs are recorded as an
// aggregate (`cg_ambiguous_fanout`) instead of m noise edges, plus a
// per-(language, receiver-kind) `ambiguous_fanout` run-stats bucket so recall
// reporting stays honest (strict vs covered).
describe("013 cg_ambiguous_fanout migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-ambig-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the aggregate table with the expected columns and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("013-cg-ambiguous-fanout.sql");
    expect(second.skipped).toContain("013-cg-ambiguous-fanout.sql");

    const cols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_ambiguous_fanout'",
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      ["call_expression", "candidate_count", "member", "source_rel_path", "source_symbol_id"].sort(),
    );
  });

  it("adds the ambiguous_fanout column to cg_run_stats with DEFAULT 0", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const cols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_run_stats'",
    );
    expect(cols.map((c) => c.column_name)).toContain("ambiguous_fanout");

    // Existing rows (pre-013 shape) backfill to 0 via DEFAULT — an insert that
    // omits the column must read back as 0, not NULL.
    await db.run(
      "INSERT INTO cg_run_stats (language, receiver_kind, attempted, resolved, external_skipped) VALUES (?, ?, ?, ?, ?)",
      ["ruby", "dynamic", 3, 1, 0],
    );
    const rows = await db.queryAll<{ ambiguous_fanout: number | bigint }>("SELECT ambiguous_fanout FROM cg_run_stats");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].ambiguous_fanout)).toBe(0);
  });
});
