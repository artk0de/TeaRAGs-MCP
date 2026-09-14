import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const FILENAME = "025-cg-file-resolve-stats.sql";

// bd tea-rags-mcp-xpmwg — resolve stats move from a per-run batch table to
// per-file tallies aggregated at read. The migration lands on indexes that
// already carry a `cg_run_stats` measurement, and that measurement is the ONLY
// thing a language reads until a whole-corpus run populates the new table — so
// the upgrade must leave it exactly as it was.
describe("025 cg file resolve stats migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-resolve-stats-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies on an existing DB and leaves its cg_run_stats measurement readable", async () => {
    // The pre-upgrade index: every migration before this one, plus a real run's rows.
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename !== FILENAME),
    );
    await db.recordRunStats([
      {
        language: "typescript",
        receiverKind: "bareCall",
        attempted: 175773,
        resolved: 122777,
        externalSkipped: 0,
        unresolvable: 0,
      },
    ]);

    const upgrade = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(upgrade.applied).toEqual([FILENAME]);

    const stats = await db.getRunStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      language: "typescript",
      receiverKind: "bareCall",
      attempted: 175773,
      resolved: 122777,
    });
  });

  it("creates the per-file tally table and the coverage table, both empty, and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.skipped).toContain(FILENAME);

    const fileColumns = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM duckdb_columns() WHERE table_name = 'cg_file_resolve_stats'",
    );
    expect(fileColumns.map((c) => c.column_name).sort()).toEqual(
      [
        "ambiguous_fanout",
        "attempted",
        "core_ambiguous",
        "external_skipped",
        "language",
        "no_in_project_def",
        "receiver_kind",
        "rel_path",
        "resolved",
        "unnarrowed_template",
        "unresolvable",
      ].sort(),
    );
    const coverageColumns = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM duckdb_columns() WHERE table_name = 'cg_file_resolve_stats_coverage'",
    );
    expect(coverageColumns.map((c) => c.column_name)).toEqual(["language"]);

    for (const table of ["cg_file_resolve_stats", "cg_file_resolve_stats_coverage"]) {
      const rows = await db.queryAll<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(rows[0]?.n ?? -1), table).toBe(0);
    }
  });

  it("keys the per-file table by (rel_path, receiver_kind)", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const insert =
      "INSERT INTO cg_file_resolve_stats (rel_path, receiver_kind, language, attempted, resolved) VALUES (?, ?, ?, ?, ?)";
    await db.run(insert, ["src/a.ts", "constant", "typescript", 1, 1]);
    await expect(db.run(insert, ["src/a.ts", "constant", "typescript", 2, 2])).rejects.toThrow();
  });
});
