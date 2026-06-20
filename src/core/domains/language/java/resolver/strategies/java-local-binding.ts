import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import { resolveLocalBindingType } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-cvv9 — typed-receiver call (`param.method()` /
 * `localVar.method()`) where the walker bound `receiver` to a type in
 * `ctx.localBindings`. Resolve `<Type>#member` / `<Type>.member`. Consulted
 * BEFORE the import-receiver pass and the ambiguous short-name fallback so an
 * unambiguous local type wins instead of the call being dropped (e.g.
 * `cs.charAt(i)` where `cs: CharSequence`). When the receiver IS bound,
 * `resolveByLocalType` returns a target unconditionally — the bound type is
 * authoritative.
 */
export class JavaLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const boundType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!boundType) return CONTINUE;
    return resolved(resolveByLocalType(boundType, call.member, ctx, this.cfg.mode));
  }
}
