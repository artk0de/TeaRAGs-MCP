/**
 * Shared inputs and helpers for the TS symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `TSCallResolver(tsOptions, mode)` pair).
 * `collectImportedFiles` is the one helper several strategies AND the
 * orchestrator's dispatch path share — factored here so it lives once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
} from "../../../../../contracts/types/codegraph.js";
import { mapImportToFile, type ProjectFileProbe, type TsCompilerOptions } from "../ts-path-mapper.js";

export interface ResolverConfig {
  tsOptions: TsCompilerOptions;
  mode: AmbiguousResolveMode;
  /**
   * Project-tree oracle the path mapper uses to pick a specifier's real
   * extension — `./Button.js` is `Button.ts` in one project and `Button.tsx`
   * in the next (bd tea-rags-mcp-f3zcy). Omitted only by tests that build a
   * config literal; the mapper then keeps its conservative `.ts` mapping.
   */
  fileExists?: ProjectFileProbe;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-k4wpn). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted;
   * env `CODEGRAPH_TS_CONE_MAX` overrides at composition.
   */
  coneMax?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_TS_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * The set of in-project files the caller imports, each mapped through the
 * tsconfig path mapper. Bare npm specifiers (mapped to `null`) are excluded.
 * Used to narrow ambiguous candidates to files the caller can actually reach.
 */
export function collectImportedFiles(
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): Set<string> {
  const files = new Set<string>();
  for (const imp of ctx.imports) {
    const file = mapImportToFile(imp.importText, ctx.callerFile, tsOptions, fileExists);
    if (file) files.add(file);
  }
  return files;
}

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
 */
export function reexportOriginFile(
  name: string,
  importedFile: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): string | null {
  const declarations = ctx.symbolTable.lookup(name);
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
