import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";

describe("006 cg edge_kind/confidence + cg_run_stats migration (bd 2jet/j431)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-kind-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds edge_kind + confidence to cg_symbols_edges_method, creates cg_run_stats, idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("006-cg-edge-kind.sql");
    expect(second.skipped).toContain("006-cg-edge-kind.sql");

    const methodCols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_symbols_edges_method'",
    );
    expect(methodCols.map((c) => c.column_name)).toEqual(expect.arrayContaining(["edge_kind", "confidence"]));

    const runStatsCols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_run_stats'",
    );
    expect(runStatsCols.map((c) => c.column_name).sort()).toEqual(["attempted", "receiver_kind", "resolved"].sort());
  });

  it("defaults edge_kind='exact' and confidence=1.0 for inserted method edges", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      "INSERT INTO cg_symbols_edges_method (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression) VALUES ('A#m', 'a.rb', 'B#n', 'b.rb', 'x.n')",
    );
    const rows = await db.queryAll<{ edge_kind: string; confidence: number }>(
      "SELECT edge_kind, confidence FROM cg_symbols_edges_method WHERE source_symbol_id = 'A#m'",
    );
    expect(rows[0]?.edge_kind).toBe("exact");
    expect(rows[0]?.confidence).toBeCloseTo(1.0, 5);
  });
});
