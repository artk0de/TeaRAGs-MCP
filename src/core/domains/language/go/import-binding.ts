/**
 * The name a Go import binds in the importing file — defined ONCE for the
 * walker (which must know which locals shadow a package) and the resolver
 * (which must know which receiver names one). Zero imports, so neither side
 * depends on the other for it (`.claude/rules/codegraph-walkers.md`).
 *
 * The alias when the source spells one — once aliased, the path's last
 * segment is NOT in scope (bd tea-rags-mcp-e6xx) — else the path's last
 * `/`-segment. A dot import (`.`) puts the package's names in the file's own
 * scope and a blank import (`_`) binds nothing, so neither binds a qualifier.
 */

import type { ImportRef } from "../../../contracts/types/codegraph.js";

const GO_NON_QUALIFIER_IMPORT_NAMES: ReadonlySet<string> = new Set([".", "_"]);

/** The qualifier `imp` binds, `undefined` for a dot or blank import. */
export function goImportBoundName(imp: ImportRef): string | undefined {
  const explicit = imp.importedNames?.[0];
  if (explicit !== undefined) return GO_NON_QUALIFIER_IMPORT_NAMES.has(explicit) ? undefined : explicit;
  const segments = imp.importText.split("/");
  return segments[segments.length - 1] ?? "";
}
