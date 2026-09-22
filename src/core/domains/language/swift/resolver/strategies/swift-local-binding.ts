import { CONTINUE } from "../../../../../contracts/resolution.js";
import { resolveLocalBindingType, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveSwiftBoundTypeMember, SWIFT_PSEUDO_RECEIVERS, type SwiftResolverConfig } from "./shared.js";

/**
 * A receiver the walker typed — a parameter annotation, an annotated `let` /
 * `var`, or a CapWords initializer (`var tmp = Helper()`).
 *
 * FIRST in the chain because Swift scoping says so: a local declaration
 * SHADOWS a stored property of the enclosing type with the same name, so a
 * `let db: MockDatabase` inside a `Store` method must beat `Store.db`'s
 * declared type. Reading `resolveLocalBindingType` (never
 * `ctx.localBindings?.[receiver]`) is what makes that position-aware — a
 * re-bound name keeps one entry per declaration and the most recent one at or
 * before the call line wins.
 *
 * When the receiver IS bound the answer is terminal: `resolveSwiftBoundTypeMember`
 * resolves or DROPS, never falls through.
 */
export class SwiftLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || SWIFT_PSEUDO_RECEIVERS.has(call.receiver)) return CONTINUE;
    const boundType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!boundType) return CONTINUE;
    return resolveSwiftBoundTypeMember(boundType, call.member, ctx, this.cfg.mode);
  }
}
