import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { resolveLocalBinding, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveTypeInstanceMethod, resolveTypeStaticMethod, type ResolverConfig } from "./shared.js";

/**
 * Walker-inferred local type wins over heuristic resolution. When the receiver
 * maps to a known class via `var = ClassName.new`, `var = Model.find(id)`, or
 * YARD `@param var [Class]`, resolution is constrained to that class — if the
 * method isn't defined there, the edge is DROPPED rather than guessed (which is
 * the source of false positives like `serializer.is_valid` resolving to user
 * classes that happen to define an `is_valid` method).
 *
 * This is a **guard** strategy for any receiver carrying a local binding: once
 * the binding exists the call is terminal — it resolves (a file-only edge still
 * counts as resolved when the type's file is known but the method isn't), or it
 * drops when the type's file is entirely unknown. It never falls through to the
 * later heuristic passes, mirroring the original orchestrator's `return`.
 */
export class RubyLocalTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine);
    if (!binding) return CONTINUE;
    // Walker-inferred local type → shared precise type→method lookup (scope-tail
    // + prepend + ancestor MRO). Once a local binding exists the call is terminal
    // — a miss (the type's file is unknown) DROPS rather than falling through to
    // a heuristic pass.
    //
    // Class-valued binding (`var = User`): resolve the STATIC method (`User.find`)
    // via the dot-form filter. Instance-valued binding (default): resolve the
    // instance method (`User#save`) via the hash-form filter, excluding any same-
    // named class method from ambiguating the pick (bd Increment B / var=CONST).
    const resolve =
      binding.valueKind === "class" ? resolveTypeStaticMethod : resolveTypeInstanceMethod;
    const target = resolve(binding.type, call.member, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
