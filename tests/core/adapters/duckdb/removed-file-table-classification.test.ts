import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import {
  REMOVED_FILE_EDGE_TABLES,
  REMOVED_FILE_REL_PATH_TABLES,
  REMOVED_FILE_SOURCE_TABLES,
} from "../../../../src/core/adapters/duckdb/file-graph-store.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-89k7k.35.5 — every base table that keys rows by a file path
 * must be CLASSIFIED for per-file removal: either the `removeFile` /
 * `removeFiles` cascade clears it (the `REMOVED_FILE_*` lists), or another
 * owner keeps it consistent and the reason is written down here.
 *
 * The cascade lists are hand-kept, and a table missing from them leaves a
 * deleted file's rows behind — that happened three times (bd xpmwg resolve
 * stats, 4p3sb.8 identifiers, vi0wx type declarations). `remove-files-batch`
 * cannot see it: its per-path and batch sides read the same lists. This guard
 * derives the path-keyed table set from the migrated schema, so a new table
 * fails here until someone decides who removes its rows.
 */

/** A column that names a repository file: `rel_path`, `source_rel_path`, `rel_path_a`, … */
const PATH_COLUMN = /(^|_)rel_path(_|$)/;

/**
 * Path-keyed tables the removed-file cascade deliberately does NOT clear, each
 * with the owner that keeps a deleted file's rows from going stale.
 */
const NOT_PER_FILE_TABLES: Readonly<Record<string, string>> = {
  cg_symbols_cycles:
    "derived: pruned per deleted file by pruneDerivedForDeletedFiles (dy852) and rebuilt by the full recompute",
  cg_symbols_metrics:
    "derived: pruned per deleted file by pruneDerivedForDeletedFiles (dy852) and rebuilt by replacePageRanks",
  cg_symbol_signals_prev: "previous-run signal baseline: recreated as a whole by the signal-drift snapshot",
  cg_file_signals_prev: "previous-run signal baseline: recreated as a whole by the signal-drift snapshot",
  cg_temporal_files: "temporal co-change: recreated as a whole from git history by the co-change build",
  cg_temporal_edges_cochange: "temporal co-change: recreated as a whole from git history by the co-change build",
  cg_temporal_bundle_files: "temporal co-change: recreated as a whole from git history by the co-change build",
  cg_temporal_symbol_commits:
    "temporal symbol commits: gone files pruned by the symbol-commit hook (DuckDbTemporalSymbolCommitStore#deleteFiles)",
};

const CASCADE_TABLES: ReadonlySet<string> = new Set([
  ...REMOVED_FILE_EDGE_TABLES,
  ...REMOVED_FILE_SOURCE_TABLES,
  ...REMOVED_FILE_REL_PATH_TABLES,
]);

async function pathKeyedTables(db: DuckDbGraphClient): Promise<string[]> {
  const rows = await db.queryAll<{ table_name: string; column_name: string }>(
    "SELECT c.table_name, c.column_name FROM information_schema.columns c " +
      "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
      "WHERE t.table_type = 'BASE TABLE' AND t.table_schema = 'main'",
  );
  return [...new Set(rows.filter((r) => PATH_COLUMN.test(r.column_name)).map((r) => r.table_name))].sort();
}

function unclassified(tables: readonly string[]): string[] {
  return tables.filter((table) => !CASCADE_TABLES.has(table) && !(table in NOT_PER_FILE_TABLES));
}

describe("removed-file cascade classification (89k7k.35.5)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-removed-file-classification-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies every path-keyed table of the migrated schema", async () => {
    const tables = await pathKeyedTables(db);
    expect(tables.length).toBeGreaterThan(0);
    expect(unclassified(tables)).toEqual([]);
  });

  it("names no table the schema does not have (a dropped table leaves no stale entry)", async () => {
    const tables = new Set(await pathKeyedTables(db));
    const classified = [...CASCADE_TABLES, ...Object.keys(NOT_PER_FILE_TABLES)];
    expect(classified.filter((table) => !tables.has(table))).toEqual([]);
  });

  it("an exemption and a cascade entry never name the same table", () => {
    expect(Object.keys(NOT_PER_FILE_TABLES).filter((table) => CASCADE_TABLES.has(table))).toEqual([]);
  });

  it("reports a new path-keyed table nobody classified", async () => {
    await db.exec("CREATE TABLE cg_guard_probe (rel_path VARCHAR NOT NULL, payload VARCHAR)");
    expect(unclassified(await pathKeyedTables(db))).toEqual(["cg_guard_probe"]);
  });
});
