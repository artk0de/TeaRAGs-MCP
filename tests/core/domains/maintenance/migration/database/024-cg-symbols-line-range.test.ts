import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { SQL_024_CG_SYMBOLS_LINE_RANGE } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/024-cg-symbols-line-range.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../src/core/domains/maintenance/migration/database/migrations",
);

// bd tea-rags-mcp-9i2ow — the payload healer maps a stored chunk to the symbol
// that owns it by the symbol's line range, and outside a walk the only place
// that range lives is `cg_symbols`. Nullable: a row written before this column
// existed carries no range, and the owner rule falls back to the chunk's own
// payload symbolId for it.
describe("024 cg_symbols line range migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-line-range-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds nullable start_line / end_line INTEGER columns to cg_symbols and is idempotent", async () => {
    const first = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(first.applied).toContain("024-cg-symbols-line-range.sql");
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("024-cg-symbols-line-range.sql");
    expect(second.skipped).toContain("024-cg-symbols-line-range.sql");

    const columns = await db.queryAll<{ column_name: string; data_type: string; is_nullable: boolean }>(
      "SELECT column_name, data_type, is_nullable FROM duckdb_columns() WHERE table_name = 'cg_symbols' AND column_name IN ('start_line', 'end_line') ORDER BY column_name",
    );
    expect(columns).toEqual([
      { column_name: "end_line", data_type: "INTEGER", is_nullable: true },
      { column_name: "start_line", data_type: "INTEGER", is_nullable: true },
    ]);
  });

  it("leaves a row written before the migration with NULL ranges", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES ('a.ts', 'A', 'A', 'A', '[]')",
    );
    expect(await db.queryAll("SELECT start_line, end_line FROM cg_symbols")).toEqual([
      { start_line: null, end_line: null },
    ]);
  });

  it("keeps the .ts export and the .sql twin byte-identical in their statements", () => {
    const twin = readFileSync(join(MIGRATIONS_DIR, "024-cg-symbols-line-range.sql"), "utf8");
    expect(stripSqlComments(twin)).toBe(stripSqlComments(SQL_024_CG_SYMBOLS_LINE_RANGE));
  });

  it("is registered in DATABASE_MIGRATIONS with the .ts export as its sql", () => {
    const entry = DATABASE_MIGRATIONS.find((m) => m.filename === "024-cg-symbols-line-range.sql");
    expect(entry).toBeDefined();
    expect(entry?.sql).toBe(SQL_024_CG_SYMBOLS_LINE_RANGE);
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
