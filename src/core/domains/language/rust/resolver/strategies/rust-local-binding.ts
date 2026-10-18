import { nearestCallResultBinding, resolveLocalBinding } from "../../../../../contracts/types/codegraph.js";
import { LocalBindingSymbolResolutionStrategy, type ReceiverTypingPorts } from "../../../kernel/index.js";
import { rustDeclaredCallResultType } from "../declared-call-result-type.js";
import { createRustTypeMemberLookup } from "../rust-type-member-lookup.js";
import { rustMethodCallResultType } from "./rust-type-receiver.js";
import type { ResolverConfig } from "./shared.js";

const RUST_LOCAL_BINDING_TYPING: ReceiverTypingPorts = {
  typeOfReceiver: (call, ctx) => {
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (binding === undefined) {
      return (
        rustDeclaredCallResultType(call.receiver, call.startLine, ctx) ??
        rustMethodCallResultType(call.receiver, call.startLine, ctx) ??
        null
      );
    }
    if (binding.typeRef !== undefined) {
      return binding.typeRef.form === "instance" && binding.typeRef.name.length > 0 ? binding.typeRef : null;
    }
    if (binding.type.length > 0) return { form: "instance", name: binding.type };
    const callBinding = nearestCallResultBinding(ctx.callResultBindings, call.receiver, call.startLine);
    const returnType = callBinding === undefined ? undefined : ctx.functionReturnTypes?.[callBinding.callee];
    return returnType === undefined ? null : { form: "instance", name: returnType };
  },
};

/**
 * bd tea-rags-mcp-c5by — when `localBindings` type-binds the receiver to a
 * known type, resolve against THAT type's members first AND drop the global
 * short-name fallback when the type lacks the member. Prevents `obj.clone()`
 * (obj: Worker) silently routing to `Error#clone`. Mirrors Java 9t8z / Go e6xx
 * "drop unsafe short-name fallback when receiver type known but member
 * missing". Tries the `#` (instance) form first, then `.` (associated
 * function), preferring the same-file candidate when the type name collides
 * across files (bd tea-rags-mcp-p8wz).
 *
 * Guard pass: a known receiver type whose member is absent DROPS the edge —
 * falling through to short-name lookup would resolve to a method on an
 * unrelated type (the c5by garbage). A receiver with no bound type continues
 * to the import-match / short-name passes.
 */
export class RustLocalBindingSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    super("localBinding", RUST_LOCAL_BINDING_TYPING, createRustTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}
