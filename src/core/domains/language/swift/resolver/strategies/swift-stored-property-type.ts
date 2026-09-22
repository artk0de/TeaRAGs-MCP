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
 * The property's type comes from the resolver's shared
 * {@link SwiftMemberTypeLookup}: the caller's own file first, then the run-wide
 * union of every file that re-opens the type, then up the superclass chain.
 * Reading only the caller's own `classFieldTypes` — as this pass did before —
 * missed exactly the shapes Swift is built out of: a property declared by an
 * `extension` in another file, and one declared on a base class. The wider read
 * cannot steal an edge from the passes below, because every one of them either
 * answers BARE calls only or matches a receiver that is a TYPE NAME, and a
 * stored property is neither.
 *
 * A chained receiver (`self.a.b.method()`) carries no single type and is
 * declined here. `chainedReceiverType`, one slot EARLIER, is what threads it —
 * and because that pass folds its hops through the SAME lookup, it answers the
 * `self.<x>` shape identically where this one can and CONTINUEs where it
 * cannot, which is what leaves the DROP above intact.
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
    const typeName = this.cfg.memberTypes.typeOfProperty(enclosing, property, ctx);
    if (!typeName) return explicitSelf ? DROP : CONTINUE;
    return resolveSwiftBoundTypeMember(typeName, call.member, ctx, this.cfg.mode);
  }
}
