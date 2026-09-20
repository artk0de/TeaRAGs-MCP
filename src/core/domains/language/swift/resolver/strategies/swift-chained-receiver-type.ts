import { CONTINUE } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../../kernel/receiver-type-propagation.js";
import { createSwiftReceiverTypePorts } from "../swift-receiver-type-ports.js";
import { resolveSwiftBoundTypeMember, type SwiftResolverConfig } from "./shared.js";

/**
 * A CHAINED receiver — `a.b.method()`, `self.a.b.method()`,
 * `World.sharedWorld.method()` — typed hop by hop through the kernel fold
 * (`kernel/receiver-type-propagation.ts`), then resolved on the type the fold
 * arrives at.
 *
 * Before this pass every dotted receiver in a Swift corpus except the
 * single-property `self.<x>` form emitted NOTHING, and the shape is not
 * marginal: measured over Alamofire and Quick, receiver kind `chain` sat at
 * 0 of 212 with an in-project definition for the member. The misses are
 * properties OF properties — `self.eventMonitor.request`,
 * `currentExampleGroup.hooks.appendBefore`, `World.sharedWorld.beforeEach` —
 * which is exactly the shape `classFieldTypes` already holds the evidence for
 * and which no single-hop pass can reach.
 *
 * ## Scope: FIELD chains, because that is what the walker publishes
 *
 * The fold's ports (`../swift-receiver-type-ports.ts`) read two channels and no
 * others: `localBindings` for the head, `classFieldTypes` for every link. A
 * link that is a METHOD call is untyped — the Swift walker keeps its declared
 * return types file-locally and publishes neither `functionReturnTypes` nor
 * `structuredReturnTypes` — so `a.makeThing().run()` still emits nothing.
 * Raising that is a walker increment; it is not something this pass can
 * approximate.
 *
 * ## Only DOTTED receivers, so nothing single-hop moves
 *
 * The entry condition is a dot in the receiver, not typedness. A receiver with
 * no dot is left entirely to the three single-hop passes that already own it —
 * `localBinding`, `storedPropertyType` and `scopedTypeReceiver` — even though
 * the fold could type it. Taking those would re-answer resolved calls through
 * a different route for no gain, and this increment is measured on the chained
 * receivers alone.
 *
 * ## Chain index 3: ahead of `storedPropertyType`, behind everything else
 *
 * `storedPropertyType` claims `self.<x>` and DROPs when it cannot type `<x>`,
 * so a pass placed after it would never see that shape at all. Sitting ahead of
 * it is safe because this pass is a STRICT superset there and not a competitor:
 *
 *   - it reads the SAME `classFieldTypes` entry for the own type first, and
 *     resolves through the SAME `resolveSwiftBoundTypeMember`, so where
 *     `storedPropertyType` answers, this answers identically;
 *   - it then continues up the superclass chain, which is where
 *     `self.eventMonitor` — a field declared on `Request`, called from
 *     `DataRequest` — is typed at all;
 *   - and when the fold produces NOTHING it returns `CONTINUE`, handing the
 *     receiver straight back to `storedPropertyType` with its `self.<x>` DROP
 *     guard intact.
 *
 * It steals from nothing above it either: `super` (0) matches the bare receiver
 * `super`, `localBinding` (1) keys `localBindings` by a name that never carries
 * a dot, and `selfMember` (2) matches bare `self` / `Self`. Every pass below is
 * either a bare-call pass or declines a dotted receiver outright.
 *
 * ## Terminality: DROP once typed, CONTINUE while untyped
 *
 * The same two-state verdict `localBinding`, `storedPropertyType` and
 * `scopedTypeReceiver` already make, for the same reason: once the receiver's
 * type is known, that type is authoritative, and a member it does not declare
 * must not be pinned to an unrelated type's namesake. Swift's field channel
 * records standard-library types as readily as project ones — `self.body` is a
 * `Data`, `DetailViewController.numberFormatter` a `NumberFormatter` — so the
 * DROP is what keeps `Data.append` off a project `Buffer#append`.
 *
 * It is deliberately NOT terminal the way Python's `chainType` is. Python DROPs
 * a folded type whose FILE is outside the project, because it has an import
 * mapper that can say so; Swift has no such mapper (`import Foundation` names a
 * module, never a symbol), so "the project declares no member of this name on
 * this type" is the only honest form of that statement here, and it is already
 * what `resolveSwiftBoundTypeMember` says.
 */
export class SwiftChainedReceiverTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainedReceiverType";

  /** ONE ports object for the life of the resolver — the fold allocates nothing per call site. */
  private readonly ports: ReceiverTypePorts = createSwiftReceiverTypePorts();

  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver?.includes(".")) return CONTINUE;

    const type = propagateReceiverType(receiver, call.startLine, ctx, this.ports);
    if (type === undefined || (type.form !== "class" && type.form !== "instance")) return CONTINUE;
    return resolveSwiftBoundTypeMember(type.name, call.member, ctx, this.cfg.mode);
  }
}
