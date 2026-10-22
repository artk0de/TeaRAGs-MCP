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

/** Nested objects → dotted columns (`payload.git.file.commitCount`); arrays stay cell values; absent → null. */
export function toColumns(records: readonly object[]): ColumnTable {
  const flat = records.map((record) => {
    const cells = new Map<string, unknown>();
    flattenInto(record as Record<string, unknown>, "", cells);
    return cells;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of flat) {
    for (const key of row.keys()) {
      if (!seen.has(key)) {
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
export function tabulateRecordArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length >= MIN_TABLE_ROWS && value.every(isPlainObject)) return toColumns(value);
    return value.map(tabulateRecordArrays);
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, tabulateRecordArrays(inner)]));
}
