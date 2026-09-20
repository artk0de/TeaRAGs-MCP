import { CONTINUE } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupSwiftSymbols } from "../swift-symbol-lookup.js";
import { isSwiftTypeName } from "../swift-type-name.js";
import { resolveSwiftBoundTypeMember, SWIFT_PSEUDO_RECEIVERS, type SwiftResolverConfig } from "./shared.js";

/** Swift's nested-type join, matching `swiftKernel.scopeSeparator`. */
const SWIFT_SCOPE_SEPARATOR = ".";

/**
 * A receiver naming a type NESTED in the caller's own scope, written the way
 * Swift lets you write it: by its short name (bd tea-rags-mcp-sg35c).
 *
 * `Account.opening(name)` inside `Ledger` names a type whose symbol composes as
 * `Ledger.Account`, because a nested declaration is qualified by its enclosing
 * type. Swift's lexical lookup does that qualification for the programmer;
 * without this pass nothing did it for the resolver, and every call on a nested
 * type from inside its own parent — the ONLY place the short spelling is legal
 * — resolved to nothing. Nested types are idiomatic Swift (a `State` enum, a
 * `Configuration` struct, a `Coordinator` class per view), so the shape is
 * common rather than exotic.
 *
 * ## What it requires before it answers
 *
 * The receiver must be UpperCamelCase (`isSwiftTypeName`) and the qualified
 * probe must land on a DECLARED symbol. That is a much stronger warrant than a
 * short-name fan-out: the pass never guesses that a receiver is a type, it
 * checks, and on a lowerCamelCase receiver it costs zero lookups. A chained
 * receiver (`a.b`) and the pseudo-receivers `self` / `Self` / `super` are
 * declined outright — each is another pass's call.
 *
 * ## Innermost scope first, and the first DECLARED type is authoritative
 *
 * The walk goes outward from the caller's innermost scope (`A.B.C.T`, then
 * `A.B.T`, then `A.T`), because an inner nested type SHADOWS an outer namesake
 * — Swift's own lookup order. The first probe that names a declared type ends
 * the walk: if it declares the member, that is the edge; if it does not, the
 * verdict is DROP rather than a continued search, for the same reason
 * `localBinding` and `storedPropertyType` drop (`resolveSwiftBoundTypeMember`)
 * — the receiver's type is now known, and a namesake further out is not what
 * the source named.
 *
 * ## Why index 4
 *
 * It is a RECEIVER-typing pass, so it belongs with the other three and after
 * all of them:
 *
 *   - after `localBinding` (1): a local `let Account = …` shadows the nested
 *     type, which is Swift scoping, not a preference;
 *   - after `selfMember` (2): that pass owns `self` / `Self`, which this one
 *     declines anyway;
 *   - after `storedPropertyType` (3): a stored property whose name collides
 *     with a nested type is still a property access, and that pass's explicit-
 *     `self` DROP must not be reopened here.
 *
 * It steals nothing from the passes below it: `enclosingBareCall` (5) and
 * `globalShortName` (7) answer `call.receiver === null` only, and
 * `extensionScopeMember` (6) answers only `null` / `self` / `Self`. Every one
 * of those declines a receiver-bearing call, so this pass could sit anywhere
 * from 4 to 7 with identical behaviour today — index 4 is the one whose
 * ARGUMENT is stable, since it keeps "receiver passes first, in falling order
 * of evidence; bare-call passes after" true, and it stays correct if a pass
 * below ever grows a receiver arm.
 *
 * On a receiver that names no declared type in any enclosing scope: CONTINUE.
 * It could still be a module, a global, or a type the index does not hold.
 */
export class SwiftScopedTypeReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "scopedTypeReceiver";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver || SWIFT_PSEUDO_RECEIVERS.has(receiver) || receiver.includes(SWIFT_SCOPE_SEPARATOR)) return CONTINUE;
    if (!isSwiftTypeName(receiver)) return CONTINUE;

    for (let depth = ctx.callerScope.length; depth > 0; depth--) {
      const qualified = [...ctx.callerScope.slice(0, depth), receiver].join(SWIFT_SCOPE_SEPARATOR);
      if (lookupSwiftSymbols(ctx, qualified).length === 0) continue;
      return resolveSwiftBoundTypeMember(qualified, call.member, ctx, this.cfg.mode);
    }
    return CONTINUE;
  }
}
