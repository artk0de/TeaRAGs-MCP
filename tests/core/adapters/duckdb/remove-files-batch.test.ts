import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-b4drg — `removeFiles` is the set-based form of the per-path
 * `removeFile` + `removeSymbolsForFile` pair `handleDeletedPaths` looped over
 * (2716 deleted taxdome files: 18.8 s per path, ~1 s set-based).
 *
 * The contract is row-for-row equivalence with that loop. The seed is
 * schema-driven rather than hand-written: EVERY base table carrying a file-path
 * column gets rows naming the deleted and the kept files, in both edge
 * directions, so a table `removeFile` learns to clear and `removeFiles` does not
 * shows up here as a dump difference without this test being edited.
 */

const DELETED_A = "src/deleted-a.ts";
const DELETED_B = "src/deleted-b.ts";
const KEPT_A = "src/kept-a.ts";
const KEPT_B = "src/kept-b.ts";
const ALL_PATHS = [DELETED_A, DELETED_B, KEPT_A, KEPT_B];

/** Columns that name a file; a table carrying one is seeded per path. */
const PATH_COLUMNS = new Set([
  "rel_path",
  "source_rel_path",
  "target_rel_path",
  "member_rel_path",
  "rel_path_a",
  "rel_path_b",
]);

interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
}

async function openDb(path: string): Promise<DuckDbGraphClient> {
  const db = new DuckDbGraphClient({ path });
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  return db;
}

async function baseTableColumns(db: DuckDbGraphClient): Promise<Map<string, ColumnInfo[]>> {
  const rows = await db.queryAll<ColumnInfo>(
    "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c " +
      "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
      "WHERE t.table_type = 'BASE TABLE' AND t.table_schema = 'main' ORDER BY c.table_name, c.ordinal_position",
  );
  const byTable = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    const columns = byTable.get(row.table_name) ?? [];
    columns.push(row);
    byTable.set(row.table_name, columns);
  }
  return byTable;
}

function sqlLiteral(column: ColumnInfo, rowIndex: number, paths: ReadonlyMap<string, string>): string {
  const path = paths.get(column.column_name);
  if (path !== undefined) return `'${path}'`;
  switch (column.data_type) {
    case "BOOLEAN":
      return "true";
    case "INTEGER":
    case "BIGINT":
    case "DOUBLE":
    case "FLOAT":
      return String(rowIndex + 1);
    case "VARCHAR[]":
      return `['v${rowIndex}']`;
    default:
      return `'v${rowIndex}'`;
  }
}

/**
 * One row per path (single-path tables) or per ordered path pair (tables with
 * two path columns) — so an edge runs deleted→kept, kept→deleted,
 * deleted→deleted and kept→kept.
 */
async function seedEveryPathTable(db: DuckDbGraphClient): Promise<void> {
  for (const [table, columns] of await baseTableColumns(db)) {
    const pathColumns = columns.filter((c) => PATH_COLUMNS.has(c.column_name)).map((c) => c.column_name);
    if (pathColumns.length === 0) continue;
    const assignments: Map<string, string>[] =
      pathColumns.length === 1
        ? ALL_PATHS.map((p) => new Map([[pathColumns[0], p]]))
        : ALL_PATHS.flatMap((first) =>
            ALL_PATHS.map(
              (second) =>
                new Map([
                  [pathColumns[0], first],
                  [pathColumns[1], second],
                ]),
            ),
          );
    const tuples = assignments.map((paths, i) => `(${columns.map((c) => sqlLiteral(c, i, paths)).join(", ")})`);
    await db.exec(`INSERT INTO ${table} (${columns.map((c) => c.column_name).join(", ")}) VALUES ${tuples.join(", ")}`);
  }
}

/** Every base table but the migration ledger (its `applied_at` differs per database), every row, sorted. */
async function dumpDatabase(db: DuckDbGraphClient): Promise<Record<string, string>> {
  const dump: Record<string, string> = {};
  for (const table of [...(await baseTableColumns(db)).keys()].sort()) {
    if (table === "schema_migrations") continue;
    const rows = await db.queryAll(`SELECT * FROM ${table} ORDER BY ALL`);
    dump[table] = JSON.stringify(rows, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  }
  return dump;
}

describe("DuckDbGraphClient#removeFiles (b4drg)", () => {
  let dir: string;
  let perPath: DuckDbGraphClient;
  let batch: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-remove-files-"));
    perPath = await openDb(join(dir, "per-path.duckdb"));
    batch = await openDb(join(dir, "batch.duckdb"));
    await seedEveryPathTable(perPath);
    await seedEveryPathTable(batch);
  });

  afterEach(async () => {
    await perPath.close();
    await batch.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the database identical to the per-path removeFile + removeSymbolsForFile loop", async () => {
    const seeded = await dumpDatabase(batch);

    for (const relPath of [DELETED_A, DELETED_B]) {
      await perPath.removeFile(relPath);
      await perPath.removeSymbolsForFile(relPath);
    }
    await batch.removeFiles([DELETED_A, DELETED_B]);

    const expected = await dumpDatabase(perPath);
    expect(await dumpDatabase(batch)).toEqual(expected);
    // Sanity: the loop did remove rows, and kept files' edges between each other survive.
    expect(expected).not.toEqual(seeded);
    const keptEdges = await batch.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE source_rel_path = ? AND target_rel_path = ?",
      [KEPT_A, KEPT_B],
    );
    expect(Number(keptEdges[0]?.n)).toBe(1);
  });

  it("matches the loop for a path set larger than one insert chunk, with duplicates and unknown paths", async () => {
    const unknown = Array.from({ length: 450 }, (_, i) => `src/never-${i}.ts`);
    const relPaths = [DELETED_A, ...unknown, DELETED_B, DELETED_A];

    for (const relPath of relPaths) {
      await perPath.removeFile(relPath);
      await perPath.removeSymbolsForFile(relPath);
    }
    await batch.removeFiles(relPaths);

    expect(await dumpDatabase(batch)).toEqual(await dumpDatabase(perPath));
  });

  it("is a no-op for an empty path set", async () => {
    const seeded = await dumpDatabase(batch);
    await batch.removeFiles([]);
    expect(await dumpDatabase(batch)).toEqual(seeded);
  });

  it("can run twice on one connection (the scratch path table does not leak)", async () => {
    await batch.removeFiles([DELETED_A]);
    await batch.removeFiles([DELETED_B]);
    for (const relPath of [DELETED_A, DELETED_B]) {
      await perPath.removeFile(relPath);
      await perPath.removeSymbolsForFile(relPath);
    }
    expect(await dumpDatabase(batch)).toEqual(await dumpDatabase(perPath));
  });
});
