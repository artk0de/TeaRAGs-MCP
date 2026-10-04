/**
 * The file-level half of a codegraph storage compaction (bd tea-rags-mcp-dvzdm):
 * measuring the store, writing a compacted copy of it beside the live file, and
 * checking that copy before anything is published.
 *
 * Deliberately connection-level and stateless. The swap itself — closing the
 * live instance, renaming the copy over it, reopening — needs the instance the
 * session owns and its call gate, so it stays in
 * `DuckDbGraphSession#compactDatabaseFile`; everything here takes the
 * connection it is handed and returns.
 *
 * Why `COPY FROM DATABASE` and not an in-place rebuild: measured on a scratch
 * copy of taxdome's 1.22 GB graph, recreating every table inside the same file
 * drops the used blocks to 1,094 (≈ 287 MB) but LEAVES the file at 1.34 GB —
 * the new tables are written before the old ones free their blocks, so the
 * high-water mark only rises and DuckDB truncates nothing. A copy into a fresh
 * file is 287 MB, carries every primary key and index (9 of 9 indexes, 15 of 15
 * keys) and took 3.8 s.
 */

import { existsSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";

import type { DuckDBConnection } from "@duckdb/node-api";

import type { CodegraphStorageFootprint } from "../../contracts/types/codegraph.js";

/** Catalog alias the staged copy is attached under for the duration of the copy. */
const COMPACTION_TARGET_ALIAS = "cg_compaction_target";

/** Double-quote a catalog identifier (table or database name) for interpolation. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a string literal (a file path) for interpolation into DDL. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function rows(conn: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

/** The base tables of `database`, in catalog order. */
async function listTables(conn: DuckDBConnection, database: string): Promise<string[]> {
  const found = await rows(
    conn,
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ${quoteLiteral(database)} AND NOT temporary ORDER BY table_name`,
  );
  return found.map((r) => String(r.table_name));
}

/** `count(*)` of every table of `database`, keyed by table name — one statement. */
async function countRows(
  conn: DuckDBConnection,
  database: string,
  tables: readonly string[],
): Promise<Map<string, number>> {
  if (tables.length === 0) return new Map();
  const union = tables
    .map(
      (t) =>
        `SELECT ${quoteLiteral(t)} AS t, count(*) AS n FROM ${quoteIdentifier(database)}.main.${quoteIdentifier(t)}`,
    )
    .join(" UNION ALL ");
  return new Map((await rows(conn, union)).map((r) => [String(r.t), Number(r.n)]));
}

/** Primary keys plus explicit indexes of `database` — the structure a copy must keep. */
async function countStructure(conn: DuckDBConnection, database: string): Promise<{ keys: number; indexes: number }> {
  const [r] = await rows(
    conn,
    `SELECT
       (SELECT count(*) FROM duckdb_constraints() WHERE database_name = ${quoteLiteral(database)} AND constraint_type = 'PRIMARY KEY') AS keys,
       (SELECT count(*) FROM duckdb_indexes() WHERE database_name = ${quoteLiteral(database)}) AS indexes`,
  );
  return { keys: Number(r?.keys ?? 0), indexes: Number(r?.indexes ?? 0) };
}

/** The name the connection's own database is attached under. */
export async function currentDatabaseName(conn: DuckDBConnection): Promise<string> {
  const [r] = await rows(conn, "SELECT current_database() AS d");
  return String(r?.d);
}

/**
 * Live rows (`count(*)`) against stored row versions (`estimated_size`) over
 * every table, plus the file's size — see `storage-compaction.ts` for why this
 * pair is the dead-version signal.
 */
export async function readStorageFootprint(conn: DuckDBConnection, dbPath: string): Promise<CodegraphStorageFootprint> {
  const database = await currentDatabaseName(conn);
  const stored = await rows(
    conn,
    `SELECT COALESCE(SUM(estimated_size), 0) AS n FROM duckdb_tables() WHERE database_name = ${quoteLiteral(database)} AND NOT temporary`,
  );
  const live = await countRows(conn, database, await listTables(conn, database));
  let liveRows = 0;
  for (const n of live.values()) liveRows += n;
  return {
    liveRows,
    storedRows: Number(stored[0]?.n ?? 0),
    fileBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
  };
}

/** Unlink a staged copy and its WAL. ENOENT — the normal case — is not an error. */
export async function removeStagedCopy(stagingPath: string): Promise<void> {
  await unlink(stagingPath).catch(() => undefined);
  await unlink(`${stagingPath}.wal`).catch(() => undefined);
}

/**
 * Where a snapshot export stages its copy before renaming it onto `targetPath`
 * (bd tea-rags-mcp-xi2r9): beside the target, so the rename stays on one
 * filesystem and is atomic.
 */
export function snapshotStagingPath(targetPath: string): string {
  return `${targetPath}.snapshot-tmp`;
}

/** Whether `<dbPath>.wal` holds anything a reopen would replay. */
export function walHoldsData(dbPath: string): boolean {
  const wal = `${dbPath}.wal`;
  return existsSync(wal) && statSync(wal).size > 0;
}

/**
 * Write a compacted copy of the connection's database to `stagingPath` and
 * verify it: every table present with the same row count, every primary key and
 * index recreated, and no WAL left beside the copy — so the file alone IS the
 * database once renamed.
 *
 * The caller must hold every other writer off the connection; a row committed
 * after the copy began would not be in it. The copy reads the database as the
 * connection sees it, WAL included, so a checkpoint is needed only by a caller
 * that goes on to replace the live file (compaction) — not for the copy itself.
 * A driver failure rejects; a copy that does not match is reported as a
 * `mismatch`. Either way the caller removes the staging files.
 *
 * The copy is attached `(READ_WRITE)` explicitly: a READ_ONLY instance attaches
 * every database read-only by default and refuses to create a missing one
 * ("Cannot open database … in read-only mode: database does not exist",
 * measured on @duckdb/node-api 1.5.3), so a snapshot export from a read-only
 * session needs the mode spelled out. A read-write instance gets what it got.
 */
export async function writeCompactedCopy(conn: DuckDBConnection, stagingPath: string): Promise<CompactedCopyVerdict> {
  const database = await currentDatabaseName(conn);
  await conn.run(`ATTACH ${quoteLiteral(stagingPath)} AS ${COMPACTION_TARGET_ALIAS} (READ_WRITE)`);
  let verdict: CompactedCopyVerdict;
  try {
    await conn.run(`COPY FROM DATABASE ${quoteIdentifier(database)} TO ${COMPACTION_TARGET_ALIAS}`);
    verdict = await compareCopy(conn, database);
    await conn.run(`CHECKPOINT ${COMPACTION_TARGET_ALIAS}`);
  } catch (err) {
    // The driver error is the one worth reporting; a DETACH failing after it is noise.
    await conn.run(`DETACH ${COMPACTION_TARGET_ALIAS}`).catch(() => undefined);
    throw err;
  }
  await conn.run(`DETACH ${COMPACTION_TARGET_ALIAS}`);
  if (verdict.kind === "verified" && walHoldsData(stagingPath)) {
    return { kind: "mismatch", detail: `the copy left a WAL beside ${stagingPath}` };
  }
  return verdict;
}

/** Whether a staged copy may be published: identical content and structure, or what differs. */
export type CompactedCopyVerdict =
  | { readonly kind: "verified" }
  | { readonly kind: "mismatch"; readonly detail: string };

async function compareCopy(conn: DuckDBConnection, database: string): Promise<CompactedCopyVerdict> {
  const tables = await listTables(conn, database);
  const copiedTables = await listTables(conn, COMPACTION_TARGET_ALIAS);
  if (copiedTables.join("\n") !== tables.join("\n")) {
    return { kind: "mismatch", detail: `tables [${copiedTables.join(", ")}], expected [${tables.join(", ")}]` };
  }
  const source = await countRows(conn, database, tables);
  const copy = await countRows(conn, COMPACTION_TARGET_ALIAS, tables);
  for (const [table, n] of source) {
    if (copy.get(table) !== n) {
      return { kind: "mismatch", detail: `${table} has ${copy.get(table)} rows, expected ${n}` };
    }
  }
  const sourceStructure = await countStructure(conn, database);
  const copyStructure = await countStructure(conn, COMPACTION_TARGET_ALIAS);
  if (sourceStructure.keys !== copyStructure.keys || sourceStructure.indexes !== copyStructure.indexes) {
    return {
      kind: "mismatch",
      detail:
        `${copyStructure.keys} keys / ${copyStructure.indexes} indexes, ` +
        `expected ${sourceStructure.keys} / ${sourceStructure.indexes}`,
    };
  }
  return { kind: "verified" };
}
