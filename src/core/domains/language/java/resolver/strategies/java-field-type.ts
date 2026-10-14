import { ChainTypeSymbolResolutionStrategy, type ReceiverTypingPorts } from "../../../kernel/index.js";
import { javaFieldReceiverType } from "../java-receiver-type-ports.js";
import { createJavaTypeMemberLookup } from "../java-type-member-lookup.js";
import type { ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-cvv9 — `this.<field>.<method>()`. Read the field's declared
 * type from `classFieldTypes[enclosingClass]` and resolve the method against
 * that type. Mirrors the TS resolver's field-access branch. Only ONE level of
 * access (`this.foo.bar()`) — a deeper chain (`this.foo.bar.baz()`) carries no
 * single type and continues to later passes. Consulted BEFORE the
 * import-receiver pass so a known field type wins over ambiguous short-name
 * resolution. When the field type IS known, `resolveByLocalType` returns a
 * target unconditionally — the bound type is authoritative.
 */
export class JavaFieldTypeSymbolResolutionStrategy extends ChainTypeSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    const typing: ReceiverTypingPorts = { typeOfReceiver: (call, ctx) => javaFieldReceiverType(call, ctx) ?? null };
    super("fieldType", typing, createJavaTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}
