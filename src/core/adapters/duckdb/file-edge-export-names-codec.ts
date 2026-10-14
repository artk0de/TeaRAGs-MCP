/**
 * Column codec for the export names on `cg_symbols_edges_file` (migration 030,
 * bd tea-rags-mcp-r8hme.2): a list is stored comma-joined, "not recorded" as
 * NULL. Names are identifiers, `default` or `*`, so none contains a comma.
 */

import { createIdentifierRecord } from "../../contracts/identifier-record.js";

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

/** Between an exposed name and the target name it forwards (migration 051). */
const BINDING_SEPARATOR = ":";

/**
 * The exposed → forwarded re-export table (migration 051, bd
 * tea-rags-mcp-zl3so) as `b:a,c:c`; `undefined` (no alias recorded) → NULL.
 */
export function encodeReexportBindings(bindings: Readonly<Record<string, string>> | undefined): string | null {
  if (bindings === undefined) return null;
  const entries = Object.keys(bindings).map((exposed) => `${exposed}${BINDING_SEPARATOR}${bindings[exposed]}`);
  return entries.length > 0 ? entries.join(SEPARATOR) : null;
}

/** NULL / empty → `undefined`; otherwise the table, safe to key by any identifier. */
export function decodeReexportBindings(value: unknown): Record<string, string> | undefined {
  const entries = decodeFileEdgeExportNames(value);
  if (entries === undefined) return undefined;
  const bindings = createIdentifierRecord<string>();
  for (const entry of entries) {
    const at = entry.indexOf(BINDING_SEPARATOR);
    if (at > 0) bindings[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return bindings;
}
