/**
 * Persistence for `cg_symbols_edges_field` (migration 049, bd
 * tea-rags-mcp-zy6hx, D0) — which method reads or writes which field.
 *
 * Writes replace a file's rows as a whole through
 * {@link replaceFileScopedRows}, the `cg_identifiers` write: the table has no
 * key, so the unit of change is the FILE, and a re-walked file whose rows did
 * not move is left physically untouched. Reads answer a method's whole access
 * set (the per-method vector the cohesion and divergence detectors compare) or
 * a file's rows, each in one query per bind chunk.
 */

import type {
  CodegraphFieldAccessStore,
  FieldAccessKind,
  FieldAccessOwnerKind,
  FieldAccessReplaceEntry,
  FieldAccessRow,
  RelPath,
  StoredFieldAccessRow,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import { replaceFileScopedRows, type FileScopedRowTable } from "./file-scoped-row-replace.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { placeholders } from "./sql-binding.js";

/** Column order of every `cg_symbols_edges_field` write and read. */
const CG_SYMBOLS_EDGES_FIELD_COLUMNS = [
  "source_rel_path",
  "source_symbol_id",
  "owner_kind",
  "owner_type",
  "receiver",
  "field_name",
  "access_kind",
  "access_count",
  "first_line",
] as const;

const CG_SYMBOLS_EDGES_FIELD_TABLE: FileScopedRowTable<FieldAccessRow> = {
  table: "cg_symbols_edges_field",
  fileColumn: "source_rel_path",
  columns: CG_SYMBOLS_EDGES_FIELD_COLUMNS,
  cells: (relPath, row) => [
    relPath,
    row.sourceSymbolId,
    row.ownerKind,
    row.ownerType ?? null,
    row.receiver ?? null,
    row.fieldName,
    row.accessKind,
    row.accessCount,
    row.firstLine,
  ],
};

/** Values per `IN (…)` list of a read. */
const FIELD_ACCESS_READ_CHUNK = 200;

/** The columns after the key both reads order by — a fixed tie order, so a read is deterministic. */
const FIELD_ACCESS_TIE_ORDER = "field_name, owner_kind, owner_type NULLS FIRST, receiver NULLS FIRST, access_kind";

interface FieldAccessDbRow {
  source_rel_path: string;
  source_symbol_id: string;
  owner_kind: string;
  owner_type: string | null;
  receiver: string | null;
  field_name: string;
  access_kind: string;
  access_count: number;
  first_line: number | null;
}

function toStoredFieldAccessRow(row: FieldAccessDbRow): StoredFieldAccessRow {
  return {
    relPath: row.source_rel_path,
    sourceSymbolId: row.source_symbol_id,
    ownerKind: row.owner_kind as FieldAccessOwnerKind,
    ...(row.owner_type === null ? {} : { ownerType: row.owner_type }),
    ...(row.receiver === null ? {} : { receiver: row.receiver }),
    fieldName: row.field_name,
    accessKind: row.access_kind as FieldAccessKind,
    accessCount: Number(row.access_count),
    firstLine: Number(row.first_line),
  };
}

export class DuckDbFieldAccessStore implements CodegraphFieldAccessStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async replaceFieldAccessesBulk(entries: readonly FieldAccessReplaceEntry[]): Promise<void> {
    return replaceFileScopedRows(this.session, CG_SYMBOLS_EDGES_FIELD_TABLE, entries);
  }

  async readFieldAccessesBySymbols(symbolIds: readonly SymbolId[]): Promise<StoredFieldAccessRow[]> {
    return this.readWhereIn(
      "source_symbol_id",
      symbolIds,
      `source_symbol_id, source_rel_path, ${FIELD_ACCESS_TIE_ORDER}`,
    );
  }

  async readFieldAccessesByFiles(relPaths: readonly RelPath[]): Promise<StoredFieldAccessRow[]> {
    return this.readWhereIn(
      "source_rel_path",
      relPaths,
      `source_rel_path, source_symbol_id, ${FIELD_ACCESS_TIE_ORDER}`,
    );
  }

  /** Rows whose `column` is one of `values`, deduplicated, in `orderBy` order across every chunk. */
  private async readWhereIn(
    column: "source_symbol_id" | "source_rel_path",
    values: readonly string[],
    orderBy: string,
  ): Promise<StoredFieldAccessRow[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];
    const rows: FieldAccessDbRow[] = [];
    for (let i = 0; i < unique.length; i += FIELD_ACCESS_READ_CHUNK) {
      const chunk = unique.slice(i, i + FIELD_ACCESS_READ_CHUNK);
      rows.push(
        ...(await this.session.queryAll<FieldAccessDbRow>(
          `SELECT ${CG_SYMBOLS_EDGES_FIELD_COLUMNS.join(", ")} FROM cg_symbols_edges_field
            WHERE ${column} IN (${placeholders(chunk)}) ORDER BY ${orderBy}`,
          chunk,
        )),
      );
    }
    if (unique.length > FIELD_ACCESS_READ_CHUNK) rows.sort(compareByOrderKey(column));
    return rows.map(toStoredFieldAccessRow);
  }
}

/** The in-memory twin of a read's ORDER BY, for a read that spanned several chunks. */
function compareByOrderKey(column: "source_symbol_id" | "source_rel_path") {
  const secondary = column === "source_symbol_id" ? "source_rel_path" : "source_symbol_id";
  const keys = [column, secondary, "field_name", "owner_kind", "owner_type", "receiver", "access_kind"] as const;
  return (a: FieldAccessDbRow, b: FieldAccessDbRow): number => {
    for (const key of keys) {
      const left = a[key] ?? "";
      const right = b[key] ?? "";
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  };
}
