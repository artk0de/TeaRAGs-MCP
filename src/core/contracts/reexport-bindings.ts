/**
 * The two spellings of a re-exported name (bd tea-rags-mcp-zl3so).
 *
 * A re-export forwards a TARGET name (`reexportedExportNames`, the target's
 * spelling) and exposes it under the name an importer of THIS file writes. The
 * two differ only under an alias — `export { a as b } from`, `import { a };
 * export { a as b }`, `export * as ns from` — and then
 * `reexportedExportBindings` maps every exposed name to the target name it
 * forwards. Every consumer that compares names against what a facade or shim
 * EXPOSES reads {@link exposedReexportNames}; one that follows a name into the
 * target reads {@link reexportSourceName}. Absent bindings = exposed names are
 * the source names, so an unaliased edge reads exactly as before.
 */

import { createIdentifierRecord, identifierEntry } from "./identifier-record.js";

/** The re-export facts an import reference or file edge carries. */
export interface ReexportNameFacts {
  readonly reexportedExportNames?: readonly string[];
  readonly reexportedExportBindings?: Readonly<Record<string, string>>;
}

/**
 * The names an importer of the re-exporting file can take, in its spelling;
 * `undefined` when no re-export was recorded ("not recorded" is never
 * "exposes nothing").
 */
export function exposedReexportNames(facts: ReexportNameFacts): readonly string[] | undefined {
  if (facts.reexportedExportNames === undefined) return undefined;
  return facts.reexportedExportBindings === undefined
    ? facts.reexportedExportNames
    : Object.keys(facts.reexportedExportBindings);
}

/** The target name an exposed name forwards — itself when the edge renames nothing. */
export function reexportSourceName(facts: ReexportNameFacts, exposedName: string): string {
  return identifierEntry(facts.reexportedExportBindings, exposedName) ?? exposedName;
}

/**
 * The bindings table of two re-export fact sets of ONE edge, unioned: absent
 * when neither renames, otherwise complete — a side without a table adds its
 * source names as identity entries, so the union stays a complete table.
 */
export function unionReexportBindings(
  first: ReexportNameFacts,
  second: ReexportNameFacts,
): Record<string, string> | undefined {
  if (first.reexportedExportBindings === undefined && second.reexportedExportBindings === undefined) return undefined;
  const bindings = createIdentifierRecord<string>();
  for (const facts of [first, second]) {
    for (const exposed of exposedReexportNames(facts) ?? []) bindings[exposed] = reexportSourceName(facts, exposed);
  }
  return bindings;
}

/** Spread-ready: the bindings field when present, nothing otherwise. */
export function reexportBindingsField(bindings: Readonly<Record<string, string>> | undefined): {
  reexportedExportBindings?: Record<string, string>;
} {
  return bindings === undefined ? {} : { reexportedExportBindings: { ...bindings } };
}
