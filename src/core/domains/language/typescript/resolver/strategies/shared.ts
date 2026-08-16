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
  return pickSingleCandidate([...new Set(declarations.map((def) => def.relPath))], mode);
}
