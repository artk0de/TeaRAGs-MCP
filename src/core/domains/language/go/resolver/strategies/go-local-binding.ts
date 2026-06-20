import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { resolveLocalBindingType } from "../../../../../contracts/types/codegraph.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * Step 0 (bd tea-rags-mcp-e6xx) — walker-inferred local type wins over
 * heuristic resolution. When the receiver maps to a known type via `(r *Type)`
 * receiver, `(p Type)` value param, or `func f(p *Type)` parameter, resolution
 * is constrained to that type; edges to unrelated symbols with the same
 * short-name are never fabricated.
 *
 * This is a **guard** strategy: once `localBindings[receiver]` names a type, the
 * call is owned here — it either resolves (`Type#member` / `Type.member`) or
 * **drops**. It must NOT fall through to a global short-name lookup, which would
 * fabricate a false-positive edge to an unrelated same-named symbol.
 */
export class GoLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const localType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!localType) return CONTINUE;
    const target = resolveByLocalType(this.cfg, localType, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
