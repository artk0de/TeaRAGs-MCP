import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { boundCallReturnType } from "../type-propagation.js";
import { resolveTypeMethod, type ResolverConfig } from "./shared.js";

/**
 * The single precise target the `returnTypeBinding` pass emits for `call`, or
 * `null` when it cannot answer. Exported so `RubyDynamicDispatchResolver` can
 * DEFER to this pass exactly when it will produce an edge — the same deference
 * `chainType` already gets there via `typeOfReceiver` (bd tea-rags-mcp-epydb).
 *
 * The predicate is the resolved TARGET, not merely a known type: a binding whose
 * return type is a gem / stdlib class yields `null` here, so the dynamic fan-out
 * keeps firing for it and recall is unchanged wherever the exact path is silent.
 */
export function resolveBoundCallTarget(
  call: CallRef,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  if (!call.receiver) return null;
  const returnType = boundCallReturnType(call.receiver, ctx);
  // Container / union results are not threaded here — a member call on a relation
  // is the cone resolver's business, not a single-target binding.
  if (returnType?.form !== "class" && returnType?.form !== "instance") return null;
  return resolveTypeMethod(returnType.name, call.member, ctx, mode);
}

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
 *
 * ── SCOPE-QUALIFIED BINDINGS (bd tea-rags-mcp-j9xpf) ──
 * A binding whose RHS receiver was a CONSTANT is recorded qualified
 * (`result = Billing::X::Create.call(…)` → `"Billing::X::Create.call"`); a
 * Ruby method name never contains `.`, so the two forms are unambiguous. The
 * qualified form knows the receiver's type, so it asks {@link returnTypeOf} —
 * the ONE return-type authority — about the CLASS object, reaching the SCOPED
 * channels (`structuredReturnTypes["Type#member"]`, the ancestor MRO) that the
 * bare form structurally cannot: the flat map is keyed by bare method name, and
 * `call` is the most collided name in a Rails codebase. `returnTypeOf` consults
 * that same flat map last, so the qualified path is a strict SUPERSET of the
 * bare one. Container / union results are not threaded (a member call on a
 * relation is the cone resolver's business) and CONTINUE.
 */
export class RubyReturnTypeBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "returnTypeBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const target = resolveBoundCallTarget(call, ctx, this.cfg.mode);
    // `null` = no binding, or the return type resolves to no project file
    // (gem/stdlib) — weak inference, so fall through to later passes rather
    // than DROP.
    return target ? resolved(target) : CONTINUE;
  }
}
