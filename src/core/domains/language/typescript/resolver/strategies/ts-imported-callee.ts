import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import { reexportOriginFile, type ResolverConfig } from "./shared.js";

/**
 * BARE call whose callee is a binding an import introduced (bd
 * tea-rags-mcp-w65s7) — the callee twin of `namedImport`, which asks the same
 * question of a RECEIVER.
 *
 * Nothing in the chain answered it. Passes 1-7 all gate on `call.receiver`,
 * `sameFile` looks only inside the CALLER's file, and `globalShortName` looks
 * the callee TEXT up in the symbol table — which for
 * `import { create as createAction } from "./repo"` is a name no file in the
 * project declares, so the call fell through every pass and out the bottom. The alias is exactly the information `importedNames` throws away:
 * it records the LOCAL binding, and the local binding is what the call site
 * spells. `ImportRef.importedBindings` carries the other half, and this pass is
 * the only reader of it.
 *
 * Measured with the type-checker oracle (2026-08-16): on taxdome 632 of the 645
 * cross-file class-B misses were this shape, every one a bareCall and 630
 * landing on a `FunctionDeclaration`; on this repo's own `src`, 17 of the
 * missed defects, all of them the destructured `await import()` form the walker
 * now records.
 *
 * Three shapes, one question. Which of them produced the binding does not reach
 * here at all — the walker normalises `import { a as b }`, `const { a: b } =
 * await import(…)`, `const { a: b } = require(…)` and `const { b } = Namespace`
 * into the same local→exported entry, so the pass has one rule to apply.
 *
 * PRECISION over recall, in three places:
 *
 *   - a specifier that maps to no project file (`zustand`, `react`) declines
 *     rather than matching the exported name globally. An npm import that
 *     happens to share a name with a project symbol is the classic fabricated
 *     edge, and `globalShortName`'s external guard is downstream of here;
 *   - a top-level declaration is preferred over any other in the same file
 *     before ambiguity is declared. A named export IS top-level, so this only
 *     ever separates the export from a same-named method the file also
 *     declares; with neither decisive, the call CONTINUEs rather than guessing;
 *   - nothing is parked. `namedImport` defers a file-only edge because passes
 *     11-15 can still pin the member, but their gate reads
 *     `lookupByShortName(call.member)` — the ALIAS — and finds nothing, so a
 *     park here would be an edge no later pass could ever correct.
 *
 * Chain position 6, and the index is a correctness argument in ONE direction.
 * Against the receiver-gated passes it decides nothing — 1-5, 7 and 8 all
 * return CONTINUE on a bare call. Against 9-11 it decides everything:
 *
 *   - `sameFile` (9) matches a bare callee against every short name the
 *     caller's file declares, its own METHODS included. `git-cli/adapter.ts`
 *     calls the free function `getHead` it imports from `./client.js`, and
 *     `sameFile` answered `GitCliAdapter#getHead` — the method doing the
 *     delegating. Running ahead of it turned 18 of this repo's bareCall
 *     `wrongFile` rows into matches and cost none, because an imported binding
 *     called bare is never the enclosing class's method;
 *   - `globalShortName` (10) and `importNarrowedFallback` (11) guess from a
 *     short name, and a guess must not beat the import statement — the misroute
 *     bd tea-rags-mcp-5tatv had to add a checker-backed guard for.
 */
export class TSImportedCalleeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importedCallee";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver) return CONTINUE;
    for (const imp of ctx.imports) {
      const exportedName = imp.importedBindings?.[call.member];
      if (exportedName === undefined) continue;
      const importedFile = mapImportToFile(imp.importText, ctx.callerFile, this.cfg.tsOptions, this.cfg.fileExists);
      if (!importedFile) continue;
      const targetFile = reexportOriginFile(exportedName, importedFile, ctx, this.cfg.mode) ?? importedFile;
      const hit = this.pinInFile(exportedName, targetFile, ctx);
      if (hit) return resolved(hit);
    }
    return CONTINUE;
  }

  /**
   * The declaration of `exportedName` inside `targetFile`, top-level first.
   *
   * A module exports its members at file scope, so the top-level candidate is
   * the one the import binds; the wider lookup behind it recovers a member
   * destructured off an imported CLASS (`const { create } = Repository`), whose
   * declaration carries the class in its scope. Both go through
   * `pickSingleCandidate`, so an undecidable file yields `null` and the call
   * continues down the chain unanswered rather than picking a side.
   */
  private pinInFile(exportedName: string, targetFile: string, ctx: CallContext): SymbolResolutionTarget | null {
    const inFile = ctx.symbolTable.lookupByShortName(exportedName).filter((def) => def.relPath === targetFile);
    const topLevel = pickSingleCandidate(
      inFile.filter((def) => def.scope.length === 0),
      this.cfg.mode,
    );
    const hit = topLevel ?? pickSingleCandidate(inFile, this.cfg.mode);
    return hit ? { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId } : null;
  }
}
