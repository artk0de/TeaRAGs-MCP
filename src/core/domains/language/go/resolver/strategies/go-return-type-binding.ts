import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { goLocalAt } from "../../local-scope.js";
import { goCallResultType, resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * Step 0b — function-return-type binding (bd tea-rags-mcp-6g9c). When the
 * receiver was assigned from a function call (`engine := New()`), its call
 * binding carries the called function and `functionReturnTypes` carries that
 * function's DECLARED return type. Bind the receiver to that type ONLY when
 * the return type is a single concrete struct/type symbol that EXISTS in the
 * table — interfaces, builtins (`string`, `error`), and external `pkg.Type`s
 * have no type symbol and SKIP (CONTINUE), falling through to the import /
 * drop path. This is SAFE: declared return types are static, not guesses.
 *
 * The call binding is the one `goLocalAt` answers with — in scope only after
 * its declaring statement and within its block (bd tea-rags-mcp-e6xx), and
 * only when no value binding of the name was declared after it. Once the gate
 * passes the call is owned: `resolveByLocalType` either resolves or **drops**
 * (no global short-name fallback — mirrors the m46z drop). When the gate fails
 * (no call binding in scope, unknown return type, or not a concrete type
 * symbol) the strategy CONTINUEs.
 */
export class GoReturnTypeBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "returnTypeBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const local = goLocalAt(ctx, call.receiver, call.startLine);
    if (local?.kind !== "call") return CONTINUE;
    const returnType = goCallResultType(local.callee, ctx);
    if (!returnType) return CONTINUE;
    const target = resolveByLocalType(this.cfg, returnType, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
