import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { isKnownTypeSymbol, resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * Step 0b — function-return-type binding (bd tea-rags-mcp-6g9c). When the
 * receiver was assigned from a function call (`engine := New()`),
 * `localCallBindings[receiver]` carries the called func short name and
 * `functionReturnTypes` carries that func's DECLARED return type. Bind the
 * receiver to that type ONLY when the return type is a single concrete
 * struct/type symbol that EXISTS in the table — interfaces, builtins (`string`,
 * `error`), and external `pkg.Type`s have no type symbol and SKIP (CONTINUE),
 * falling through to the import / drop path. This is SAFE: declared return
 * types are static, not guesses.
 *
 * `localBindings` (direct type) is checked first by the preceding strategy so it
 * always wins. Once the gate passes the call is owned: `resolveByLocalType`
 * either resolves or **drops** (no global short-name fallback — mirrors the
 * m46z drop). When the gate fails (no `calledFunc`, unknown return type, or the
 * return type is not a concrete type symbol) the strategy CONTINUEs.
 */
export class GoReturnTypeBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "returnTypeBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const calledFunc = ctx.localCallBindings?.[call.receiver];
    if (!calledFunc) return CONTINUE;
    const returnType = ctx.functionReturnTypes?.[calledFunc];
    if (!returnType || !isKnownTypeSymbol(returnType, ctx)) return CONTINUE;
    const target = resolveByLocalType(this.cfg, returnType, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
