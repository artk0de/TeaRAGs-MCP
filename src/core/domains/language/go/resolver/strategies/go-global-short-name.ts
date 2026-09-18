import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupGoSymbolsByShortName } from "../go-symbol-lookup.js";
import { goImportPackageDir, goPackageDirOf, type ResolverConfig } from "./shared.js";

/**
 * Step 3 — no receiver: a bare `Util()`. In Go a bare identifier names a
 * declaration of the caller's OWN package (its directory), of a dot-imported
 * package, or a builtin — never another package's (bd tea-rags-mcp-e6xx). So the
 * short-name candidates are the package-level declarations (`symbolId` equal
 * to the member — a method is never called bare) in those directories only: a
 * namesake anywhere else neither resolves the call nor makes it ambiguous, as
 * the whole-table search did (gin's render `WriteString(...)` lost to the
 * root package's `responseWriter#WriteString`).
 *
 * `pickSingleCandidate(mode)` returns the sole hit (strict) or the first hit
 * (legacy `first` mode); two in-scope declarations — build-tag twins such as
 * gin's `binding.go` / `binding_nomsgpack.go` `validate` — stay ambiguous under
 * strict mode. A receiver-present call never reaches here — it CONTINUEs. A
 * non-decisive result also CONTINUEs; exhausting the chain returns null.
 */
export class GoGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver) return CONTINUE;
    const scope = this.bareCallPackageDirs(ctx);
    const candidates = lookupGoSymbolsByShortName(ctx, call.member).filter(
      (def) => def.symbolId === call.member && scope.has(goPackageDirOf(def.relPath)),
    );
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }

  /** The caller's package directory plus every dot-imported project package's. */
  private bareCallPackageDirs(ctx: CallContext): Set<string> {
    const dirs = new Set([goPackageDirOf(ctx.callerFile)]);
    for (const imp of ctx.imports) {
      if (imp.importedNames?.[0] !== ".") continue;
      const dir = goImportPackageDir(imp.importText, this.cfg.moduleMaps?.forRoot(ctx.projectRoot));
      if (dir !== undefined) dirs.add(dir);
    }
    return dirs;
  }
}
