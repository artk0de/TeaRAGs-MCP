import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupGoSymbols } from "../go-symbol-lookup.js";
import { goPackageDirOf, resolveImportedPackageMember, type ResolverConfig } from "./shared.js";

/**
 * `name[...]` or `qualifier.name[...]` — a (possibly package-qualified)
 * identifier followed by one bracketed group; the qualifier and the name are
 * captured bare.
 */
const GO_INDEXED_CALLEE = /^(?:([\p{L}_][\p{L}\p{N}_]*)\.)?([\p{L}_][\p{L}\p{N}_]*)\[.*\]$/su;

/**
 * Step 2b (bd tea-rags-mcp-e6xx) — an explicitly instantiated generic function
 * or type, called by its bare or package-qualified name: gin's
 * `getTyped[string](c, key)`, `slices.Map[int](xs, f)`, and the one-argument
 * forms `pair[int](x)` / `pkg.Pair[int](x)` the walker collects from a
 * conversion to a generic type.
 *
 * The walker reports such a callee verbatim, so the call arrives as a BARE call
 * whose member is the whole instantiated name, and no pass could look it up.
 * Syntax cannot tell the instantiation from an index (`fs[i](x)`,
 * `c.handlers[c.index](c)`), but the symbol table can: indexing a FUNCTION is
 * not legal Go, so when the operand names a declaration the brackets are type
 * arguments and the call is a call of that declaration.
 *   - Bare `f[T]`: a bare identifier resolves in its own package, so only a
 *     declaration in the caller's package directory counts.
 *   - Qualified `pkg.F[T]`: with the type arguments stripped it is the call
 *     `pkg.F`, answered by the same import lookup `importMatch` uses (module
 *     path, alias, one directory, package-level declaration). Go has no
 *     generic methods, so a qualifier that names no import — a value, as in
 *     `c.handlers[c.index](c)` — makes it an index.
 * A local in effect under the operand's name (the bare name, or the qualifier)
 * shadows the declaration or the package; two declarations (build-tag twins)
 * stay ambiguous.
 *
 * Non-guard: anything else CONTINUEs to `globalShortName`, which finds nothing
 * for a bracketed member — exactly the pre-pass outcome.
 */
export class GoGenericInstantiationSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "genericInstantiation";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver) return CONTINUE;
    const match = GO_INDEXED_CALLEE.exec(call.member);
    if (match === null) return CONTINUE;
    const [, qualifier, name] = match;
    // Any local in effect shadows the declaration or the package — typed or not.
    if (resolveLocalBinding(ctx.localBindings, qualifier ?? name, call.startLine)) return CONTINUE;
    const target =
      qualifier === undefined
        ? this.samePackageDeclaration(name, ctx)
        : resolveImportedPackageMember(this.cfg, qualifier, name, ctx);
    return target ? resolved(target) : CONTINUE;
  }

  private samePackageDeclaration(name: string, ctx: CallContext): SymbolResolutionTarget | null {
    const callerPackage = goPackageDirOf(ctx.callerFile);
    const candidates = lookupGoSymbols(ctx, name).filter((def) => goPackageDirOf(def.relPath) === callerPackage);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }
}
