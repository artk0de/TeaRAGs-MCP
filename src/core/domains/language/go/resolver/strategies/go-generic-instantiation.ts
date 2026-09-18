import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { goPackageDirOf, type ResolverConfig } from "./shared.js";

/** `name[...]` — an identifier followed by one bracketed group, captured bare. */
const GO_INDEXED_CALLEE = /^([\p{L}_][\p{L}\p{N}_]*)\[.*\]$/su;

/**
 * Step 2b (bd tea-rags-mcp-e6xx) — an explicitly instantiated generic function
 * called by its bare name: gin's `getTyped[string](c, key)`.
 *
 * The walker reports a non-selector callee verbatim, so the call arrives as
 * member `getTyped[string]` and no pass could look it up. Syntax cannot tell
 * the instantiation from `fs[i](x)` — both are an `index_expression` — but the
 * symbol table can: indexing a FUNCTION is not legal Go, so when the operand
 * names a function (or type, for `Box[int](x)`) declared in the caller's own
 * package, the brackets are type arguments and the call is a call of that
 * declaration. A bare identifier resolves in its own package, so a namesake in
 * another package is not in scope; a typed local of the operand's name shadows
 * the declaration; two declarations (build-tag twins) are ambiguous.
 *
 * Non-guard: anything else CONTINUEs to `globalShortName`, which finds nothing
 * for a bracketed member — exactly the pre-pass outcome. A method cannot carry
 * type parameters in Go, so a selector operand (`x.f[i](…)`) is never an
 * instantiation and never reaches here with a receiver.
 */
export class GoGenericInstantiationSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "genericInstantiation";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver) return CONTINUE;
    const operand = GO_INDEXED_CALLEE.exec(call.member)?.[1];
    if (operand === undefined) return CONTINUE;
    // Any local in effect shadows the declaration — typed or not.
    if (resolveLocalBinding(ctx.localBindings, operand, call.startLine)) return CONTINUE;
    const callerPackage = goPackageDirOf(ctx.callerFile);
    const candidates = ctx.symbolTable
      .lookup(operand)
      .filter((def) => def.relPath.endsWith(".go") && goPackageDirOf(def.relPath) === callerPackage);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId }) : CONTINUE;
  }
}
