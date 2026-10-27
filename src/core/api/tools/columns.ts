/** Records as one header + one row each: the key text is paid once per response. */
export interface ColumnTable {
  columns: string[];
  rows: unknown[][];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenInto(record: Record<string, unknown>, prefix: string, cells: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenInto(value, path, cells);
    else cells.set(path, value);
  }
}

/**
 * Nested objects → dotted columns (`payload.git.file.commitCount`); arrays stay cell values; absent → null.
 * A column null in EVERY row is omitted (bd tea-rags-mcp-e6es3): null already means absent, so it is pure
 * header cost — e.g. the `rankingOverlay: undefined` every non-reranked row carries.
 */
export function toColumns(records: readonly object[], columnOrder: readonly string[] = []): ColumnTable {
  const flat = records.map((record) => {
    const cells = new Map<string, unknown>();
    flattenInto(record as Record<string, unknown>, "", cells);
    return cells;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  // Pinned columns lead in the tool's own order, whatever the first row carries: first-seen order alone
  // lets a null-valued key in row 1 move its column behind the rest.
  for (const key of columnOrder) {
    if (flat.some((row) => row.get(key) !== null && row.get(key) !== undefined)) {
      seen.add(key);
      columns.push(key);
    }
  }
  for (const row of flat) {
    for (const [key, cell] of row) {
      if (cell !== null && cell !== undefined && !seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return { columns, rows: flat.map((row) => columns.map((column) => row.get(column) ?? null)) };
}

/** A table pays off from the second row: one row repeats every nested prefix in its column names. */
const MIN_TABLE_ROWS = 2;

/** Records as a ColumnTable from MIN_TABLE_ROWS on; fewer stay the records they are. */
export function tabulateRecords<T extends object>(records: readonly T[]): ColumnTable | readonly T[] {
  return records.length >= MIN_TABLE_ROWS ? toColumns(records) : records;
}

/** Every array of two or more plain objects, at any depth, becomes a ColumnTable. */
export function tabulateRecordArrays(value: unknown, columnOrder: readonly string[] = []): unknown {
  if (Array.isArray(value)) {
    if (value.length >= MIN_TABLE_ROWS && value.every(isPlainObject)) return toColumns(value, columnOrder);
    return value.map((inner) => tabulateRecordArrays(inner, columnOrder));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, tabulateRecordArrays(inner, columnOrder)]),
  );
}

export function isColumnTable(value: Record<string, unknown>): value is ColumnTable & Record<string, unknown> {
  const keys = Object.keys(value);
  return keys.length === 2 && Array.isArray(value.columns) && Array.isArray(value.rows);
}

function recordOf(columns: string[], row: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    const cell = row[index];
    if (cell === null || cell === undefined) return;
    const path = column.split(".");
    let target = record;
    for (const key of path.slice(0, -1)) {
      target[key] ??= {};
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]] = cell;
  });
  return record;
}

/** Inverse of tabulation for readers that want records: every ColumnTable, at any depth, back to its records. */
export function foldColumnTables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(foldColumnTables);
  if (!isPlainObject(value)) return value;
  if (isColumnTable(value)) return value.rows.map((row) => recordOf(value.columns, row));
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, foldColumnTables(inner)]));
}
