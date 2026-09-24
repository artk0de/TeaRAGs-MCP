import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "027-cg-derived-file-scoped-key.sql";
const PRE_027 = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-4g9ga — `cg_symbols_metrics` (004) was keyed `symbol_id`
 * alone and `cg_symbols_cycles` (003) held bare method-scope member ids, so
 * every namesake shared one PageRank and one cycle vertex. 027 rebuilds both
 * tables keyed by the declaring FILE as well (020's pattern: CREATE new →
 * INSERT SELECT → DROP old → RENAME), and recreates none of the secondary
 * indexes 018 / 019 deliberately dropped.
 */
describe("027 keys the derived codegraph tables by (rel_path, symbol_id)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-derived-key-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function primaryKeyColumns(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ constraint_column_names: string[] }>(
      "SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
      [table],
    );
    return rows[0]?.constraint_column_names ?? [];
  }

  async function indexesOn(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = ?",
      [table],
    );
    return rows.map((r) => r.index_name);
  }

  it("keys cg_symbols_metrics on (rel_path, symbol_id)", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    expect(await primaryKeyColumns("cg_symbols_metrics")).toEqual(["rel_path", "symbol_id"]);
    expect(await indexesOn("cg_symbols_metrics")).toEqual([]);
  });

  it("keys cg_symbols_cycles on the member's file as well as its id", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    expect(await primaryKeyColumns("cg_symbols_cycles")).toEqual(["cycle_id", "scope", "member_rel_path", "member"]);
    expect(await indexesOn("cg_symbols_cycles")).toEqual([]);
  });

  it("carries existing rows: file-scope members name their own file, method/metric rows an unknown one", async () => {
    await runMigrations(db, PRE_027);
    await db.run("INSERT INTO cg_symbols_cycles (cycle_id, scope, member, position) VALUES (0, 'file', 'src/a.ts', 0)");
    await db.run("INSERT INTO cg_symbols_cycles (cycle_id, scope, member, position) VALUES (0, 'method', 'A#run', 0)");
    await db.run("INSERT INTO cg_symbols_metrics (symbol_id, page_rank) VALUES ('A#run', 0.25)");

    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await db.queryAll("SELECT scope, member_rel_path, member FROM cg_symbols_cycles ORDER BY scope")).toEqual([
      { scope: "file", member_rel_path: "src/a.ts", member: "src/a.ts" },
      { scope: "method", member_rel_path: "", member: "A#run" },
    ]);
    expect(await db.queryAll("SELECT rel_path, symbol_id, page_rank FROM cg_symbols_metrics")).toEqual([
      { rel_path: "", symbol_id: "A#run", page_rank: 0.25 },
    ]);
  });
});
