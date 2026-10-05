import { resolveLocalBinding } from "../../../../../contracts/types/codegraph.js";
import { LocalBindingSymbolResolutionStrategy, type ReceiverTypingPorts } from "../../../kernel/index.js";
import { createRubyTypeMemberLookup } from "../ruby-type-member-lookup.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Ruby's local-binding typing: the walker's `localBindings` entry in scope at
 * the call line. Class-valued binding (`var = User`) types the receiver as the
 * CLASS, so the lookup resolves the STATIC method (`User.find`) via the
 * dot-form filter. Instance-valued binding (default) types an INSTANCE, so the
 * lookup resolves the instance method (`User#save`) via the hash-form filter,
 * excluding any same-named class method from ambiguating the pick (bd
 * Increment B / var=CONST).
 */
const RUBY_LOCAL_TYPE_TYPING: ReceiverTypingPorts = {
  typeOfReceiver: (call, ctx) => {
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (!binding) return null;
    return { form: binding.valueKind === "class" ? "class" : "instance", name: binding.type };
  },
};

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
 *
 * The verdict is the kernel's `LocalBindingSymbolResolutionStrategy` (bd
 * tea-rags-mcp-m99j1.1.5): shared precise type→method lookup (scope-tail +
 * prepend + ancestor MRO) through Ruby's `TypeMemberLookup`, DROP on a typed
 * miss.
 */
export class RubyLocalTypeSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    super("localType", RUBY_LOCAL_TYPE_TYPING, createRubyTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}
