/**
 * `reexportOriginFile` — follow a barrel to the file that DECLARES a name.
 *
 * Relocated from `typescript/resolver/strategies/shared.ts` (bd
 * tea-rags-mcp-9fgdi, E2 seam 1) when Python pulled on it: a Python package
 * `__init__.py` re-exports exactly the way a TS barrel does — `from .app import
 * Flask as Flask` (flask 39, polar 36), star re-export plus `__all__` (netbox
 * 178 star lines, `__all__` in 433 modules) — and the mechanism that answers it
 * is hop-agnostic symbol-table lookup, not anything TypeScript-shaped.
 *
 * Behaviour-preserving relocation per `.claude/rules/resolver-architecture.md`
 * §4: the function, its gates and its docblock are byte-identical to the
 * TypeScript original. `typescript/resolver/strategies/shared.ts` re-exports it
 * so every TS consumer and TS test keeps its import path.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolDefinition,
} from "../../../contracts/types/codegraph.js";

/**
 * The file a barrel re-exports `name` FROM, or `null` when the import is not a
 * re-export hop (bd tea-rags-mcp-hzsxy).
 *
 * `import { X } from "./index.js"` maps to the BARREL, but a barrel declares
 * nothing — `X` lives in a file the barrel re-exports. Left alone, the named-
 * import pass emits its terminal file-only edge against `index.ts`: the wrong
 * file, and no later pass gets to correct it. Measured over this repo's own
 * `src`, 611 named imports reach this gate, and 144 of them are that shape —
 * every one of the 144 held a file-only edge on a barrel before, and pins a
 * real symbol on the declaring file after. None of the 144 previously pinned a
 * symbol, so the hop cannot cost an edge that already existed.
 *
 * The hop asks the SYMBOL TABLE where the name is declared rather than reading
 * the barrel's `export … from` list, and that is the whole design:
 *
 *   - the barrel's own imports are not reachable from here. `ctx.imports` is
 *     the CALLER's list, and `collectReexport` in the walker deliberately
 *     records a re-export's module path WITHOUT its names (a re-export binds
 *     no local name, so calling them `importedNames` would be a lie). Reading
 *     them would mean new run-global context plumbed through the pass-1→pass-2
 *     barrier — see the bead for why that stayed out of scope;
 *   - asking where a name is DECLARED is hop-count-agnostic. A barrel that
 *     re-exports another barrel costs exactly one lookup, and no chain depth
 *     needs bounding;
 *   - `export * from` is covered for free, where a name-based re-export list
 *     would have had to descend into each starred module anyway.
 *
 * Three gates keep it from guessing, and on the same corpus they decline 467 of
 * the 611 without a single ambiguous drop. The name must be in the symbol table
 * at all (118 declines) — `tsNameOf` names classes, functions and methods, so a
 * namespace written `export const X = { … }` leaves nothing to hop to, and
 * constant receivers such as `SOME_TABLE.has(k)` can never be retargeted at a
 * same-named class. The mapped file must NOT declare the name itself (349
 * declines), or nothing was re-exported and the direct-import behaviour stands
 * untouched. And the declaration must be unique: `pickSingleCandidate` drops a
 * name declared in several files, because with no re-export list to consult
 * there is no way to tell which one the barrel meant, and the existing barrel
 * edge beats a coin flip.
 *
 * That last gate had a hole, and it cost taxdome its component graph (bd
 * tea-rags-mcp-ex28m). "Declared in several files" is not the same question as
 * "ambiguous to THIS barrel": `ui-kit/index.ts` says
 * `export { Button } from 'ui-kit/components/Button/Button'`, so it is perfectly
 * specific about which of the project's two `Button` files it re-exports — the
 * global lookup simply never asked. Every barrel-imported component whose short
 * name another package also declares therefore resolved to nothing, and with no
 * checker to fall back on (the repair and recompute legs run without one) the
 * edge was dropped in silence. Measured on the real
 * `ConfirmationModal.tsx` with the production walker: `<Button>` twice → NO
 * EDGE, while `<Modal>`, `<Layout>` and `<Preloader>` — each declared once —
 * resolved beside it.
 *
 * So an ambiguous global answer is retried against the barrel's OWN package,
 * the directory the barrel file sits in. A barrel re-exports what its package
 * owns; a same-named component in a sibling package is not a candidate for it,
 * which makes this narrowing evidence rather than preference. Two candidates
 * INSIDE the package still decline — there the barrel genuinely cannot say
 * which, and the original reasoning stands.
 *
 * That first gate is also this hop's ceiling. The `Barrel.staticMember()`
 * `wrongFile` rows the type-checker oracle reports are exactly the const-object
 * namespace shape, so closing THEM is a symbol-extraction question, not an
 * import-mapping one — tracked separately.
 *
 * Shared by the receiver-keyed named-import pass and the bare-call
 * imported-callee pass (bd tea-rags-mcp-w65s7): both map a specifier to a file
 * and then have to ask the same barrel question of it, and two copies of these
 * three gates would drift.
 *
 * `lookupDeclarations` is the caller language's own way into the table (bd
 * tea-rags-mcp-t5cji). The table is one polyglot index with no `language`
 * field, so the default `ctx.symbolTable.lookup` lets a Ruby `class Widget`
 * answer a TypeScript barrel whose `Widget` is a `forwardRef` the walker never
 * names — the hop then lands the import on a `.rb` file — and lets a foreign
 * namesake beside the real declaration make the answer ambiguous. The kernel
 * stays language-neutral: TypeScript passes `lookupEcmascriptSymbols`; a
 * caller that passes nothing keeps the unfiltered lookup it always had.
 */
export function reexportOriginFile(
  name: string,
  importedFile: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  lookupDeclarations: (ctx: CallContext, name: string) => SymbolDefinition[] = (c, n) => c.symbolTable.lookup(n),
): string | null {
  const declarations = lookupDeclarations(ctx, name);
  if (declarations.length === 0) return null;
  if (declarations.some((def) => def.relPath === importedFile)) return null;
  const candidates = [...new Set(declarations.map((def) => def.relPath))];
  const unique = pickSingleCandidate(candidates, mode);
  if (unique !== null) return unique;
  // Ambiguous across the project — ask the barrel's own package (bd
  // tea-rags-mcp-ex28m). Legacy `first` mode never reaches here: it already
  // picked, so its behaviour is untouched.
  return pickSingleCandidate(withinPackageOf(importedFile, candidates), mode);
}

/**
 * The candidates that live under `barrelFile`'s own directory — the package a
 * barrel is entitled to re-export from. Prefix-matched on the directory plus a
 * separator so `ui-kit` cannot claim a sibling named `ui-kit-legacy`.
 */
function withinPackageOf(barrelFile: string, candidates: readonly string[]): string[] {
  const packageDir = barrelFile.includes("/") ? barrelFile.slice(0, barrelFile.lastIndexOf("/")) : "";
  if (packageDir === "") return [];
  return candidates.filter((relPath) => relPath.startsWith(`${packageDir}/`));
}
