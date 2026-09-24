import { CONTINUE } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ReceiverTypePorts } from "../../../kernel/receiver-type-propagation.js";
import { createSwiftReceiverTypePorts, swiftLocalValueType } from "../swift-receiver-type-ports.js";
import { resolveSwiftBoundTypeMember, SWIFT_PSEUDO_RECEIVERS, type SwiftResolverConfig } from "./shared.js";

/**
 * A receiver that names a LOCAL — one the walker typed (a parameter
 * annotation, an annotated `let` / `var`, a CapWords initializer), or one it
 * recorded by the SPELLING of a right-hand side whose links live in other
 * files (`let evaluator = try manager.serverTrustEvaluator(forHost:)`), folded
 * here through the kernel receiver fold (bd tea-rags-mcp-y99pg.6).
 *
 * FIRST in the chain because Swift scoping says so: a local declaration
 * SHADOWS a stored property of the enclosing type with the same name, so a
 * `let db: MockDatabase` inside a `Store` method must beat `Store.db`'s
 * declared type. The lookup is position-aware — a re-bound name keeps one
 * entry per declaration and the most recent one at or before the call line
 * wins (`swiftLocalValueType`).
 *
 * When the receiver IS a typed local the answer is terminal:
 * `resolveSwiftBoundTypeMember` resolves or DROPS. A spelling that folds to
 * nothing CONTINUEs, as an unrecorded local always did (see
 * `swiftLocalValueType` for why it does not drop).
 */
export class SwiftLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";

  /** ONE ports object for the life of the resolver — the fold allocates nothing per call site. */
  private readonly ports: ReceiverTypePorts;

  constructor(private readonly cfg: SwiftResolverConfig) {
    this.ports = createSwiftReceiverTypePorts(cfg.memberTypes);
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || SWIFT_PSEUDO_RECEIVERS.has(call.receiver)) return CONTINUE;
    const boundType = swiftLocalValueType(call.receiver, call.startLine, ctx, this.ports, this.cfg.memberTypes);
    if (boundType === undefined) return CONTINUE;
    return resolveSwiftBoundTypeMember(boundType, call.member, ctx, this.cfg, call);
  }
}
