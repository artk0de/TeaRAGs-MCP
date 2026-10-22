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
export function toColumns(records: readonly Record<string, unknown>[]): ColumnTable {
  const flat = records.map((record) => {
    const cells = new Map<string, unknown>();
    flattenInto(record, "", cells);
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

/** Every array of two or more plain objects, at any depth, becomes a ColumnTable. */
export function tabulateRecordArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every(isPlainObject)) return toColumns(value);
    return value.map(tabulateRecordArrays);
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, tabulateRecordArrays(inner)]));
}
