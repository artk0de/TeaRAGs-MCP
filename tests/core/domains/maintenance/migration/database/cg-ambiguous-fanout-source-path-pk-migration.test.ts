import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "027-cg-ambiguous-fanout-source-path-pk.sql";
const LEGACY = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);

/**
 * bd tea-rags-mcp-n9bmd — `cg_ambiguous_fanout` was keyed
 * `(source_symbol_id, call_expression)` by 013, with no `source_rel_path`.
 *
 * The same defect class migration 020 removed from the method-edge table (bd
 * tea-rags-mcp-ex28m): a SymbolId is unique per FILE, so two files whose
 * namesake callers emit the same over-cap fan-out produced ONE key, and the
 * write path's `INSERT OR IGNORE` kept only the first file's aggregate.
 */
describe("027 extends the ambiguous fan-out primary key with source_rel_path", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-fanout-pk-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function primaryKeyColumns(): Promise<string[]> {
    const rows = await db.queryAll<{ constraint_column_names: string[] }>(
      "SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = 'cg_ambiguous_fanout' AND constraint_type = 'PRIMARY KEY'",
    );
    return rows[0]?.constraint_column_names ?? [];
  }

  async function indexes(): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_ambiguous_fanout' ORDER BY index_name",
    );
    return rows.map((r) => r.index_name);
  }

  /** The collision shape: same caller symbolId + same call expression, two files. */
  async function insertNamesakeRows(): Promise<void> {
    for (const relPath of ["src/cli/index.ts", "src/daemon/entry.ts"]) {
      await db.run(
        `INSERT OR IGNORE INTO cg_ambiguous_fanout
           (source_symbol_id, source_rel_path, call_expression, member, candidate_count)
         VALUES (?, ?, ?, ?, ?)`,
        ["main", relPath, "handler.run", "run", 40],
      );
    }
  }

  async function namesakeCount(): Promise<number> {
    const rows = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_ambiguous_fanout WHERE source_symbol_id = 'main'",
    );
    return Number(rows[0].n);
  }

  it("keys on (source_symbol_id, source_rel_path, call_expression), the per-file writer's scope second", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await primaryKeyColumns()).toEqual(["source_symbol_id", "source_rel_path", "call_expression"]);
  });

  it("persists both namesakes' aggregates instead of collapsing them to one", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    await insertNamesakeRows();

    expect(await namesakeCount()).toBe(2);
  });

  it("NON-VACUITY: the same two rows collapse to one under the 013 key", async () => {
    await runMigrations(db, LEGACY);

    await insertNamesakeRows();

    // The defect, reproduced: the second file's aggregate is gone.
    expect(await namesakeCount()).toBe(1);
  });

  it("carries an existing database's rows and every column across the rebuild", async () => {
    await runMigrations(db, LEGACY);
    await db.run(
      `INSERT INTO cg_ambiguous_fanout (source_symbol_id, source_rel_path, call_expression, member, candidate_count)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      ["Runner#go", "app/runner.rb", "x.firm", "firm", 240, "Other#zap", "app/other.rb", "a.user", "user", 18],
    );

    const result = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(result.applied).toEqual([MIGRATION]);
    const rows = await db.queryAll<{
      source_symbol_id: string;
      source_rel_path: string;
      call_expression: string;
      member: string;
      candidate_count: number | bigint;
    }>("SELECT * FROM cg_ambiguous_fanout ORDER BY source_symbol_id");
    expect(rows.map((r) => ({ ...r, candidate_count: Number(r.candidate_count) }))).toEqual([
      {
        source_symbol_id: "Other#zap",
        source_rel_path: "app/other.rb",
        call_expression: "a.user",
        member: "user",
        candidate_count: 18,
      },
      {
        source_symbol_id: "Runner#go",
        source_rel_path: "app/runner.rb",
        call_expression: "x.firm",
        member: "firm",
        candidate_count: 240,
      },
    ]);
  });

  it("recreates both secondary indexes 013 created and 019 kept", async () => {
    await runMigrations(db, LEGACY);
    const before = await indexes();

    await runMigrations(db, DATABASE_MIGRATIONS);

    // Indexes are NOT carried by a table rename. `member` backs
    // getAmbiguousCallersByMember (019 measured it as earning its drift
    // exposure) and `source_rel_path` backs the per-file scope read/DELETE.
    expect(before).toEqual(["idx_cg_ambiguous_fanout_member", "idx_cg_ambiguous_fanout_source_rel_path"]);
    expect(await indexes()).toEqual(before);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });
});
