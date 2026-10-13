/**
 * The per-file replace of a keyless `cg_*` table whose rows a file's own walk
 * writes (`cg_identifiers`, `cg_symbols_edges_field`): make the table EQUAL
 * each entry's rows for every file the entries name, in one transaction,
 * last-wins per file, an entry with no rows clearing its file, a file no entry
 * names untouched.
 *
 * The unit of change is the FILE, and a file whose row multiset did not move is
 * left physically untouched — a recompute re-walks every file, and rewriting the
 * unchanged ones is exactly the churn the dead-row class (bd tea-rags-mcp-dvzdm)
 * turns into file growth. Every DELETE is scoped to the files it names.
 *
 * Cells are compared as text, so the caller's JS values and the driver's
 * read-back fingerprint alike: VARCHAR, INTEGER and BOOLEAN columns only, with
 * NULL and `undefined` sharing a marker no string value can produce.
 */

import type { RelPath } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { placeholders } from "./sql-binding.js";

/** Values per `IN (…)` list — the bound the session's batched writers use. */
const FILE_SCOPED_IN_LIST_CHUNK = 200;

/** Where a file-scoped table lives and how a row becomes its cells. */
export interface FileScopedRowTable<Row> {
  table: string;
  /** The column naming the file; it must also be the FIRST of {@link columns}. */
  fileColumn: string;
  columns: readonly string[];
  /** One row's cells in {@link columns} order, the file's path first. */
  cells: (relPath: RelPath, row: Row) => unknown[];
}

function chunked<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += FILE_SCOPED_IN_LIST_CHUNK) {
    chunks.push(values.slice(i, i + FILE_SCOPED_IN_LIST_CHUNK));
  }
  return chunks;
}

function fingerprintCell(cell: unknown): string | null {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "bigint" || typeof cell === "boolean") return cell.toString();
  return null;
}

/** One row as a comparable string, identical for the caller's values and the driver's read-back. */
export function fileScopedRowFingerprint(cells: readonly unknown[]): string {
  return JSON.stringify(cells.map(fingerprintCell));
}

/** A file's rows as one order-independent fingerprint — equal iff the row multisets are. */
function fileFingerprint(rowFingerprints: string[]): string {
  return rowFingerprints.sort().join("\n");
}

export async function replaceFileScopedRows<Row>(
  session: DuckDbGraphSession,
  fileScopedRowTable: FileScopedRowTable<Row>,
  entries: readonly { relPath: RelPath; rows: readonly Row[] }[],
): Promise<void> {
  if (entries.length === 0) return;
  const lastByRelPath = new Map<RelPath, readonly Row[]>();
  for (const { relPath, rows } of entries) lastByRelPath.set(relPath, rows);
  const relPaths = [...lastByRelPath.keys()];
  const columnList = fileScopedRowTable.columns.join(", ");

  return session.transaction(async () => {
    const stored = new Map<RelPath, string[]>();
    for (const chunk of chunked(relPaths)) {
      const found = await session.queryAll<Record<string, unknown>>(
        `SELECT ${columnList} FROM ${fileScopedRowTable.table} WHERE ${fileScopedRowTable.fileColumn} IN (${placeholders(chunk)})`,
        chunk,
      );
      for (const row of found) {
        const relPath = row[fileScopedRowTable.fileColumn] as RelPath;
        const list = stored.get(relPath) ?? [];
        list.push(fileScopedRowFingerprint(fileScopedRowTable.columns.map((c) => row[c])));
        stored.set(relPath, list);
      }
    }

    const changed: RelPath[] = [];
    const inserts: unknown[][] = [];
    for (const [relPath, rows] of lastByRelPath) {
      const writeRows = rows.map((r) => fileScopedRowTable.cells(relPath, r));
      const incoming = fileFingerprint(writeRows.map(fileScopedRowFingerprint));
      if (incoming === fileFingerprint(stored.get(relPath) ?? [])) continue;
      changed.push(relPath);
      inserts.push(...writeRows);
    }

    for (const chunk of chunked(changed)) {
      await session.run(
        `DELETE FROM ${fileScopedRowTable.table} WHERE ${fileScopedRowTable.fileColumn} IN (${placeholders(chunk)})`,
        chunk,
      );
    }
    await session.insertBatched(fileScopedRowTable.table, fileScopedRowTable.columns, inserts);
  });
}
