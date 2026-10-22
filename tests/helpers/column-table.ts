import type { ColumnTable } from "../../src/core/api/tools/columns.js";

/** Records back from a column table: dotted columns nest again, null cells drop. */
export function rowsOf(table: ColumnTable): Record<string, unknown>[] {
  return table.rows.map((row) => {
    const record: Record<string, unknown> = {};
    table.columns.forEach((column, index) => {
      const value = row[index];
      if (value === null) return;
      const path = column.split(".");
      let target = record;
      for (const key of path.slice(0, -1)) {
        target[key] ??= {};
        target = target[key] as Record<string, unknown>;
      }
      target[path[path.length - 1]] = value;
    });
    return record;
  });
}

/** Search `results` as records whichever form they came in: a table (2+ rows) or the records themselves. */
export function recordsOf(results: ColumnTable | Record<string, unknown>[]): Record<string, unknown>[] {
  return Array.isArray(results) ? results : rowsOf(results);
}
