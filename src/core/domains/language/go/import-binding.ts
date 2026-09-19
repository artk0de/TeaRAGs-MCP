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
 *
 * A DERIVED name is a guess, and one import's guess can collide with another
 * import's certain name: `"k8s.io/api/core/v1"` is assumed to bind `core` while
 * its clause says `v1`, and `"example.com/proj/core"` binds `core` for certain.
 * So a name an import may bind is a CLAIM with the evidence behind it
 * (`GoImportNameClaim`), and the import a name binds is the one with the most
 * certain claim to it (`goImportsByClaimedName`) — never the one listed first
 * (bd tea-rags-mcp-e6xx, F3-3).
 */

import type { ImportRef } from "../../../contracts/types/codegraph.js";

const GO_NON_QUALIFIER_IMPORT_NAMES: ReadonlySet<string> = new Set([".", "_"]);

/** A major-version path element — `v2`, `v10` — which names no package. */
const GO_MAJOR_VERSION_ELEMENT = /^v[0-9]+$/;

/** A character no Go identifier holds: not a letter, a decimal digit, or `_`. */
const GO_NON_IDENTIFIER_CHARACTER = /[^\p{L}\p{Nd}_]/u;

const GO_IDENTIFIER = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

/**
 * What a claim that an import binds a name rests on, most certain first — a
 * smaller rank outranks a larger one:
 *   - `alias`: the source spells the name;
 *   - `packageClause`: the imported package's own `package` clause, which only
 *     a reader with the package on disk has (the resolver, for a project
 *     package — never the walker);
 *   - `pathElement`: the path's last element, taken verbatim (`core` of
 *     `example.com/proj/core`, `v1` of `k8s.io/api/core/v1`);
 *   - `assumedName`: a name DERIVED from the path that is not its last element
 *     (`goAssumedPackageName` — `core` of `k8s.io/api/core/v1`).
 */
export const GO_IMPORT_NAME_EVIDENCE = {
  alias: 0,
  packageClause: 1,
  pathElement: 2,
  assumedName: 3,
} as const;

export type GoImportNameEvidence = (typeof GO_IMPORT_NAME_EVIDENCE)[keyof typeof GO_IMPORT_NAME_EVIDENCE];

/** A name an import may bind, and how certain that is. */
export interface GoImportNameClaim {
  readonly name: string;
  readonly evidence: GoImportNameEvidence;
}

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
 * The names `imp` may bind as its own spelling tells them — no package clause:
 * its alias; else its path's last element when that is an identifier
 * (`pathElement`), and the assumed name when that is a different one
 * (`assumedName`). A dot or blank import claims nothing.
 */
export function goImportNameClaims(imp: ImportRef): GoImportNameClaim[] {
  const explicit = imp.importedNames?.[0];
  if (explicit !== undefined) {
    return GO_NON_QUALIFIER_IMPORT_NAMES.has(explicit)
      ? []
      : [{ name: explicit, evidence: GO_IMPORT_NAME_EVIDENCE.alias }];
  }
  const elements = imp.importText.split("/");
  const last = elements[elements.length - 1] ?? "";
  const assumed = goAssumedPackageName(imp.importText);
  const claims: GoImportNameClaim[] = [];
  if (GO_IDENTIFIER.test(last)) claims.push({ name: last, evidence: GO_IMPORT_NAME_EVIDENCE.pathElement });
  if (claims[0]?.name !== assumed) claims.push({ name: assumed, evidence: GO_IMPORT_NAME_EVIDENCE.assumedName });
  return claims;
}

/**
 * The import each name binds: the one whose claim to it (`claimsOf`) is the
 * most certain. A name two imports claim at that best rank binds neither —
 * import order is no evidence, and a guess tied with a guess is no binding.
 */
export function goImportsByClaimedName(
  imports: readonly ImportRef[],
  claimsOf: (imp: ImportRef) => readonly GoImportNameClaim[],
): ReadonlyMap<string, ImportRef> {
  const best = new Map<string, { imp: ImportRef | undefined; evidence: GoImportNameEvidence }>();
  for (const imp of imports) {
    for (const claim of claimsOf(imp)) {
      const held = best.get(claim.name);
      if (held === undefined || claim.evidence < held.evidence) {
        best.set(claim.name, { imp, evidence: claim.evidence });
      } else if (claim.evidence === held.evidence) {
        held.imp = undefined;
      }
    }
  }
  const bound = new Map<string, ImportRef>();
  for (const [name, { imp }] of best) if (imp !== undefined) bound.set(name, imp);
  return bound;
}
