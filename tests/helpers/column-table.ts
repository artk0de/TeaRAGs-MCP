import { foldColumnTables, type ColumnTable } from "../../src/core/api/tools/columns.js";

/** Records back from a column table: dotted columns nest again, null cells drop. */
export function rowsOf(table: ColumnTable): Record<string, unknown>[] {
  return foldColumnTables(table) as Record<string, unknown>[];
}

/** Search `results` as records whichever form they came in: a table (2+ rows) or the records themselves. */
export function recordsOf(results: ColumnTable | Record<string, unknown>[]): Record<string, unknown>[] {
  return Array.isArray(results) ? results : rowsOf(results);
}
