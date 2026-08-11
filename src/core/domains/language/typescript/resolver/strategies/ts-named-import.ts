import { CONTINUE, deferred, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { targetsExternalImport } from "../ts-external-call.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * EXACT named-specifier match (bd tea-rags-mcp-2v16). The walker records the
 * local binding names each import introduces in `ImportRef.importedNames`
 * (`import { RankModule } from "./m"` → `["RankModule"]`). When the receiver is
 * one of those names we know its source module precisely — no filename
 * heuristic needed. This supersedes the kebab→Pascal basename hack for any
 * import that carries `importedNames`. Within the matched file we FQN-narrow
 * (`scope[-1] === receiver`) before short-name so multi-export modules pin the
 * right class.
 *
 * Once the target FILE resolves, an unindexed member yields a file-only edge
 * (`targetSymbolId: null`) — DEFERRED rather than committed (bd
 * tea-rags-mcp-5onmn). The import statement is real evidence of a module edge,
 * so the answer is kept; parking it lets the tail `typeChecker` passes pin the
 * member when they can, and the chain emits the module edge when they cannot.
 *
 * The barrel hop below still matters, and for a sharper reason than before.
 * A later pass can now correct a parked file, but only by pinning a SYMBOL —
 * nothing downstream re-answers "which module is this?", so a park naming the
 * barrel instead of the declaring file is an edge nobody fixes.
 *
 * The builtin-container guard on that fallback is what still declines outright
 * (bd tea-rags-mcp-4kx9f): `YARD_CONST.test(text)` maps to the file DECLARING
 * the constant, and the call enters `RegExp.prototype` instead, so there is no
 * file worth parking.
 */
export class TSNamedImportSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "namedImport";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const named = ctx.imports.find((imp) => imp.importedNames?.includes(call.receiver as string));
    if (!named) return CONTINUE;

    const importedFile = mapImportToFile(named.importText, ctx.callerFile, this.cfg.tsOptions, this.cfg.fileExists);
    if (!importedFile) return CONTINUE;
    const targetFile = reexportOriginFile(call.receiver, importedFile, ctx, this.cfg.mode) ?? importedFile;

    const scopedCandidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === call.receiver);
    const scopedHit = pickSingleCandidate(scopedCandidates, this.cfg.mode);
    if (scopedHit) return resolved({ targetRelPath: scopedHit.relPath, targetSymbolId: scopedHit.symbolId });

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });

    // The file-only edge is a claim that the call ENTERS `targetFile`, and for a
    // container constant it does not: `YARD_CONST.test(text)` runs
    // `RegExp.prototype.test` while the import points at the file declaring the
    // constant (bd tea-rags-mcp-4kx9f). Guarding here rather than at the top of
    // the pass is deliberate — a member the target file really declares has
    // already won above, so this can only ever drop a file-level edge, never a
    // pinned one. CONTINUE and not a park: this is the one case where we know
    // the module answer is wrong, and parking a wrong file is worse than none.
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions, null, this.cfg.fileExists)) return CONTINUE;
    return deferred({ targetRelPath: targetFile, targetSymbolId: null });
  }
}

/**
 * The file a barrel re-exports `receiver` FROM, or `null` when the import is
 * not a re-export hop (bd tea-rags-mcp-hzsxy).
 *
 * `import { X } from "./index.js"` maps to the BARREL, but a barrel declares
 * nothing — `X` lives in a file the barrel re-exports. Left alone, pass 5 emits
 * its terminal file-only edge against `index.ts`: the wrong file, and no later
 * pass gets to correct it. Measured over this repo's own `src`, 611 named
 * imports reach this gate, and 144 of them are that shape — every one of the
 * 144 held a file-only edge on a barrel before, and pins a real symbol on the
 * declaring file after. None of the 144 previously pinned a symbol, so the hop
 * cannot cost an edge that already existed.
 *
 * The hop asks the SYMBOL TABLE where the receiver is declared rather than
 * reading the barrel's `export … from` list, and that is the whole design:
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
 * the 611 without a single ambiguous drop. The receiver must be in the symbol
 * table at all (118 declines) — `tsNameOf` names classes, functions and
 * methods, so a namespace written `export const X = { … }` leaves nothing to
 * hop to, and constant receivers such as `SOME_TABLE.has(k)` can never be
 * retargeted at a same-named class. The mapped file must NOT declare the
 * receiver itself (349 declines), or nothing was re-exported and the
 * direct-import behaviour stands untouched. And the declaration must be
 * unique: `pickSingleCandidate` drops a name declared in several files,
 * because with no re-export list to consult there is no way to tell which one
 * the barrel meant, and the existing barrel edge beats a coin flip.
 *
 * That first gate is also this hop's ceiling. The `Barrel.staticMember()`
 * `wrongFile` rows the type-checker oracle reports are exactly the const-object
 * namespace shape, so closing THEM is a symbol-extraction question, not an
 * import-mapping one — tracked separately.
 */
function reexportOriginFile(
  receiver: string,
  importedFile: string,
  ctx: CallContext,
  mode: ResolverConfig["mode"],
): string | null {
  const declarations = ctx.symbolTable.lookup(receiver);
  if (declarations.length === 0) return null;
  if (declarations.some((def) => def.relPath === importedFile)) return null;
  return pickSingleCandidate([...new Set(declarations.map((def) => def.relPath))], mode);
}
