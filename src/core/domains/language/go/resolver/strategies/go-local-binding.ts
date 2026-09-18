import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { resolveLocalBinding, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
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
 *
 * A binding in effect with the EMPTY type is a local no pass can type — a
 * function-literal parameter of an unbindable type shadowing its name (bd
 * tea-rags-mcp-e6xx). It DROPS too: the call binding (`c := New()`) and the
 * import the parameter shadows would both speak for the wrong variable.
 */
export class GoLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine);
    if (!binding) return CONTINUE;
    if (!binding.type) return DROP;
    const target = resolveByLocalType(this.cfg, binding.type, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
