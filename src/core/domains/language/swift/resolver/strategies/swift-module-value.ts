import { CONTINUE } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ReceiverTypePorts } from "../../../kernel/index.js";
import { createSwiftReceiverTypePorts, swiftModuleValueReceiverType } from "../swift-receiver-type-ports.js";
import { resolveSwiftBoundTypeMember, SWIFT_PSEUDO_RECEIVERS, type SwiftResolverConfig } from "./shared.js";

/** A plain value name — the only receiver a module-level value can be. */
const SWIFT_IDENTIFIER_RECEIVER = /^[A-Za-z_]\w*$/;

/**
 * A receiver that names a MODULE-LEVEL value (bd tea-rags-mcp-y99pg.30) —
 * `AF.request(…)` against Alamofire's file-scope
 * `public let AF = Session.default`, called from files that never declare it.
 * The value's type comes from the walker's module-values pass: the declared
 * type, or the right-hand side folded in module scope
 * (`../swift-module-values.ts`).
 *
 * ## Chain index 6: behind every receiver pass
 *
 * A module-level value is the OUTERMOST scope a name is looked up in, so every
 * nearer binding wins: a local (`localBinding`, 1), a stored property of the
 * enclosing type (`storedPropertyType`, 4), a type visible from the caller
 * (`scopedTypeReceiver`, 5). Sitting after all three is the lookup order;
 * {@link swiftModuleValueReceiverType} re-checks each shadow anyway, so a
 * local those passes could not TYPE still hides the module value, as Swift's
 * scoping says it must.
 *
 * It steals nothing below it: `enclosingBareCall` (7) and `globalShortName`
 * (9) answer bare calls only, and `extensionScopeMember` (8) only `self` /
 * `Self` / bare. A dotted receiver headed by a module value is the chain
 * pass's (3), through the same head arm in the ports.
 *
 * ## Terminality: DROP once typed, CONTINUE while untyped
 *
 * The verdict every typed receiver pass makes: the value's type is
 * authoritative, so a member it does not declare must not fall through to a
 * namesake.
 */
export class SwiftModuleValueSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "moduleValue";

  /** ONE ports object for the life of the resolver — the fold allocates nothing per call site. */
  private readonly ports: ReceiverTypePorts;

  constructor(private readonly cfg: SwiftResolverConfig) {
    this.ports = createSwiftReceiverTypePorts(cfg.memberTypes);
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver || SWIFT_PSEUDO_RECEIVERS.has(receiver) || !SWIFT_IDENTIFIER_RECEIVER.test(receiver)) {
      return CONTINUE;
    }
    const type = swiftModuleValueReceiverType(receiver, call.startLine, ctx, this.cfg.memberTypes, this.ports);
    if (type === undefined || (type.form !== "class" && type.form !== "instance")) return CONTINUE;
    return resolveSwiftBoundTypeMember(type.name, call.member, ctx, this.cfg, call);
  }
}
