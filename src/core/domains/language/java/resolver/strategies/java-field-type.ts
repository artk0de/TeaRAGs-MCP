import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveByLocalType, type ResolverConfig } from "./shared.js";

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
export class JavaFieldTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "fieldType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || !call.receiver.startsWith("this.") || ctx.callerScope.length === 0) return CONTINUE;
    const fieldSegment = call.receiver.slice("this.".length);
    if (fieldSegment.includes(".")) return CONTINUE;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
    if (!typeName) return CONTINUE;
    return resolved(resolveByLocalType(typeName, call.member, ctx, this.cfg.mode));
  }
}
