import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveSwiftBoundTypeMember, SWIFT_PSEUDO_RECEIVERS, type SwiftResolverConfig } from "./shared.js";

/**
 * A call on a STORED PROPERTY of the enclosing type, resolved through the
 * property's declared type: `self.db.write()`, and — because Swift's `self` is
 * implicit — the bare `db.write()` that means exactly the same thing.
 *
 * The implicit-self arm is not a nicety. Omitting `self.` is the idiomatic
 * spelling everywhere it is not required for disambiguation, so a resolver that
 * only handled the explicit form would leave most field calls in a Swift corpus
 * unresolved. It runs AFTER `localBinding` so a local of the same name shadows
 * the property, which is Swift's own scoping rule.
 *
 * Two different verdicts on a miss, and the difference is load-bearing:
 *
 *   - `self.<x>` is definitively an instance-member access — never a module,
 *     never a free function. With no recorded type for `<x>`, or a type that
 *     declares no such member, there is nothing honest to emit and later passes
 *     must NOT see it: DROP (Rust's `selfField`, bd tea-rags-mcp-q1pl).
 *   - a BARE receiver that is not a known property could be anything — a local
 *     the walker could not type, a global, a module: CONTINUE.
 *
 * A chained receiver (`self.a.b.method()`) carries no single type and is left
 * to later passes, which decline it too. Recursive receiver typing is the
 * kernel's `receiver-type-propagation` fold; wiring Swift into it is a separate
 * increment, not something to approximate here.
 */
export class SwiftStoredPropertyTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "storedPropertyType";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || ctx.callerScope.length === 0) return CONTINUE;
    const explicitSelf = call.receiver.startsWith("self.");
    const property = explicitSelf ? call.receiver.slice("self.".length) : call.receiver;
    // Chained access carries no single type — decline both spellings.
    if (property.includes(".")) return CONTINUE;
    if (!explicitSelf && SWIFT_PSEUDO_RECEIVERS.has(property)) return CONTINUE;

    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = ctx.classFieldTypes?.[enclosing]?.[property];
    if (!typeName) return explicitSelf ? DROP : CONTINUE;
    return resolveSwiftBoundTypeMember(typeName, call.member, ctx, this.cfg.mode);
  }
}
