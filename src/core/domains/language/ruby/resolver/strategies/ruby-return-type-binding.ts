import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveTypeMethod, type ResolverConfig } from "./shared.js";

/**
 * Method-return-type binding (cai0 a71lj). A receiver bound by the walker to a
 * called method (`x = client.fetch`, recorded in `localCallBindings` as
 * `x -> fetch`) whose method has a known return type (`functionReturnTypes`,
 * filled from Ruby YARD `@return [T]`) resolves `x.member` to
 * `<returnType>#member` via the shared `resolveTypeMethod` (scope-tail + prepend
 * + ancestor MRO). Mirrors `GoReturnTypeBindingSymbolResolutionStrategy` — the
 * same universal `localCallBindings` + `functionReturnTypes` channels (bd 6g9c).
 *
 * Unlike the Go variant (which DROPs on a known-type-but-missing-member, m46z),
 * this pass CONTINUEs whenever it cannot pin a type: the binding is a WEAK
 * inference (the return annotation is optional), so an unknown return type
 * (gem / stdlib / unannotated) must fall through to the later passes rather than
 * terminate the chain — keeping the pass purely additive (it only ADDS
 * resolutions, never removes one another pass would have made). A return type
 * that DOES resolve to a project file but whose method is inherited yields a
 * file-only edge (resolved), matching the Ruby local-type convention.
 */
export class RubyReturnTypeBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "returnTypeBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const calledMethod = ctx.localCallBindings?.[call.receiver];
    if (!calledMethod) return CONTINUE;
    const returnType = ctx.functionReturnTypes?.[calledMethod];
    if (!returnType) return CONTINUE;
    const target = resolveTypeMethod(returnType, call.member, ctx, this.cfg.mode);
    // `null` = the return type resolves to no project file (gem/stdlib) — weak
    // inference, so fall through to later passes rather than DROP.
    return target ? resolved(target) : CONTINUE;
  }
}
