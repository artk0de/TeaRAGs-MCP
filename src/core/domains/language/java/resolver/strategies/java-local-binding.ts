import { LocalBindingSymbolResolutionStrategy, type ReceiverTypingPorts } from "../../../kernel/index.js";
import { javaLocalReceiverType } from "../java-receiver-type-ports.js";
import { createJavaTypeMemberLookup } from "../java-type-member-lookup.js";
import type { ResolverConfig } from "./shared.js";

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
export class JavaLocalBindingSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    const typing: ReceiverTypingPorts = { typeOfReceiver: (call, ctx) => javaLocalReceiverType(call, ctx) ?? null };
    super("localBinding", typing, createJavaTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}
