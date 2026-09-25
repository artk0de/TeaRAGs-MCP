/**
 * Column codec for the export names on `cg_symbols_edges_file` (migration 030,
 * bd tea-rags-mcp-r8hme.2): a list is stored comma-joined, "not recorded" as
 * NULL. Names are identifiers, `default` or `*`, so none contains a comma.
 */

const SEPARATOR = ",";

/** `undefined` / empty → NULL; otherwise the names joined. */
export function encodeFileEdgeExportNames(names: readonly string[] | undefined): string | null {
  return names && names.length > 0 ? names.join(SEPARATOR) : null;
}

/** NULL / empty → `undefined` (not recorded); otherwise the names split back. */
export function decodeFileEdgeExportNames(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split(SEPARATOR);
}
