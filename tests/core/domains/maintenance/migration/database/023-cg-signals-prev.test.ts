import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_023_CG_SIGNALS_PREV } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/023-cg-signals-prev.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../src/core/domains/maintenance/migration/database/migrations",
);

// bd tea-rags-mcp-a2ddb — `cg_symbols_metrics` and the edge tables are
// recomputed wholesale every run, but the Qdrant payload derived from them was
// rewritten only for files in the run's chunk map. These two tables hold the
// signals as of the END of the previous run so the finalizer can diff against
// them and heal exactly the points whose signals moved.
describe("023 cg signals prev migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-signals-prev-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates both prev-signal tables with their columns and is idempotent", async () => {
    const first = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(first.applied).toContain("023-cg-signals-prev.sql");
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("023-cg-signals-prev.sql");
    expect(second.skipped).toContain("023-cg-signals-prev.sql");

    const symbolColumns = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM duckdb_columns() WHERE table_name = 'cg_symbol_signals_prev'",
    );
    expect(symbolColumns.map((c) => c.column_name).sort()).toEqual([
      "fan_in",
      "fan_out",
      "page_rank",
      "rel_path",
      "symbol_id",
    ]);

    const fileColumns = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM duckdb_columns() WHERE table_name = 'cg_file_signals_prev'",
    );
    expect(fileColumns.map((c) => c.column_name).sort()).toEqual(["fan_in", "fan_out", "rel_path"]);
  });

  it("starts empty so the first run after the upgrade heals every point once", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const symbols = await db.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_symbol_signals_prev");
    const files = await db.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_file_signals_prev");
    expect(Number(symbols[0]?.n ?? -1)).toBe(0);
    expect(Number(files[0]?.n ?? -1)).toBe(0);
  });

  // The `.sql` twin is what the on-disk loader path (and a human reading the
  // schema) sees; the `.ts` export is what production ships. They drift
  // silently unless something compares them.
  it("keeps the .ts export and the .sql twin byte-identical in their statements", () => {
    const twin = readFileSync(join(MIGRATIONS_DIR, "023-cg-signals-prev.sql"), "utf8");
    expect(stripSqlComments(twin)).toBe(stripSqlComments(SQL_023_CG_SIGNALS_PREV));
  });

  it("is registered in DATABASE_MIGRATIONS with the .ts export as its sql", () => {
    const entry = DATABASE_MIGRATIONS.find((m) => m.filename === "023-cg-signals-prev.sql");
    expect(entry).toBeDefined();
    expect(entry?.sql).toBe(SQL_023_CG_SIGNALS_PREV);
  });
});

/** Statements only: the `.sql` twin carries `--` comments the `.ts` puts in JSDoc. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}
