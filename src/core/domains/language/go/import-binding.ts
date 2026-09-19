/**
 * The name a Go import binds in the importing file — defined ONCE for the
 * walker (which must know which locals shadow a package) and the resolver
 * (which must know which receiver names one). Zero imports, so neither side
 * depends on the other for it (`.claude/rules/codegraph-walkers.md`).
 *
 * The alias when the source spells one — once aliased, the path's last
 * segment is NOT in scope (bd tea-rags-mcp-e6xx) — else the name the imported
 * package's own `package` clause declares. The importing file does not carry
 * that clause, only the path, so the name is ASSUMED from the path the way Go's
 * tooling assumes it (`golang.org/x/tools` `ImportPathToAssumedName`): a
 * trailing major-version element (`/v4`) is not the name, a leading `go-` is
 * dropped, and the name ends at the first character no identifier holds —
 * `github.com/labstack/echo/v4` → `echo`, `gopkg.in/yaml.v3` → `yaml`,
 * `github.com/goccy/go-json` → `json`. The last segment itself (`v4`,
 * `yaml.v3`, `go-json`) named no import at all, so a call through the package
 * was read as a method call on a value (bd tea-rags-mcp-e6xx, G2-1). A dot
 * import (`.`) puts the package's names in the file's own scope and a blank
 * import (`_`) binds nothing, so neither binds a qualifier.
 */

import type { ImportRef } from "../../../contracts/types/codegraph.js";

const GO_NON_QUALIFIER_IMPORT_NAMES: ReadonlySet<string> = new Set([".", "_"]);

/** A major-version path element — `v2`, `v10` — which names no package. */
const GO_MAJOR_VERSION_ELEMENT = /^v[0-9]+$/;

/** A character no Go identifier holds: not a letter, a decimal digit, or `_`. */
const GO_NON_IDENTIFIER_CHARACTER = /[^\p{L}\p{Nd}_]/u;

const GO_IDENTIFIER = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

/** The qualifier `imp` binds — its alias, else its assumed name — `undefined` for a dot or blank import. */
export function goImportBoundName(imp: ImportRef): string | undefined {
  const explicit = imp.importedNames?.[0];
  if (explicit !== undefined) return GO_NON_QUALIFIER_IMPORT_NAMES.has(explicit) ? undefined : explicit;
  return goAssumedPackageName(imp.importText);
}

/**
 * The package name Go's tooling assumes for `importPath`: the last element that
 * is not a major version, with a leading `go-` dropped, cut at the first
 * character no identifier holds.
 */
export function goAssumedPackageName(importPath: string): string {
  const elements = importPath.split("/");
  let base = elements[elements.length - 1] ?? "";
  if (elements.length > 1 && GO_MAJOR_VERSION_ELEMENT.test(base)) base = elements[elements.length - 2];
  if (base.startsWith("go-")) base = base.slice("go-".length);
  const cut = base.search(GO_NON_IDENTIFIER_CHARACTER);
  return cut === -1 ? base : base.slice(0, cut);
}

/**
 * The OTHER name an unaliased import may bind: its last path element when that
 * spells an identifier the assumed name is not — only ever a major-version
 * element (`v1` of `k8s.io/api/core/v1`, whose package clause says `v1`).
 * `undefined` for an aliased, dot or blank import, and whenever the last
 * element is the assumed name or no identifier at all.
 *
 * The assumed name is an assumption, and only the package clause settles it. A
 * reader that cannot see the clause and must not miss the binding — the
 * walker's shadowed names and recorded result types, a resolver without the
 * package on disk — holds this as a second candidate, below every import's
 * bound name.
 */
export function goImportPathElementName(imp: ImportRef): string | undefined {
  if (imp.importedNames?.[0] !== undefined) return undefined;
  const elements = imp.importText.split("/");
  const last = elements[elements.length - 1] ?? "";
  return GO_IDENTIFIER.test(last) && last !== goAssumedPackageName(imp.importText) ? last : undefined;
}
