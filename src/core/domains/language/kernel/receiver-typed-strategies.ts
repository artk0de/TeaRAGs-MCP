/**
 * K4 kernel skeletons (bd tea-rags-mcp-m99j1.1.5): the receiver-typed
 * strategies every dynamic language runs, expressed once.
 *
 * A chained return type (`svc.build().run`), a local binding (`x = Foo.new;
 * x.run`) and a naming convention (`payment.refund` → `Payment#refund`) differ
 * only in HOW they type the receiver. What follows the typing is the same three
 * steps in every language: a nominal type reaches the member walk, anything
 * else is undecided, and a known type that declares nothing under the member is
 * a miss whose verdict the strategy owns. So the kernel takes two ports and
 * owns the verdict:
 *
 *   - `ReceiverTypingPorts` — the language's receiver typing, moved verbatim
 *     out of its strategy;
 *   - `TypeMemberLookup` — the language's member walk (MRO, ancestors, member
 *     spelling, file binding), see `type-member-lookup.ts`.
 *
 * The `name` is the caller's: chain-tally `--defer` and the oracle `answeredBy`
 * columns key on it, so each language keeps the string it shipped with.
 */
import { CONTINUE, DROP, resolved } from "../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy, TypeRef } from "../../../contracts/types/language.js";
import { typeMemberLookupDefinedFor, type NominalTypeRef, type TypeMemberLookup } from "./type-member-lookup.js";

/** A member call that HAS a receiver — the only calls a receiver-typed strategy speaks for. */
export type ReceiverCallRef = CallRef & { readonly receiver: string };

export interface ReceiverTypingPorts {
  /** Receiver → TypeRef, or null when the language cannot type it. */
  typeOfReceiver: (call: ReceiverCallRef, ctx: CallContext) => TypeRef | null;
}

export interface ConventionReceiverTypingPorts extends ReceiverTypingPorts {
  /**
   * Whether a REAL fact channel speaks for this receiver — a binding, a return
   * fact, a foreign right-hand side. The convention is a guess and yields to
   * any of them.
   */
  isTypedElsewhere: (call: ReceiverCallRef, ctx: CallContext) => boolean;
}

export interface ReceiverTypedStrategyOptions {
  /**
   * The verdict on a TYPED miss — the receiver's type is known and nominal, and
   * the member walk found nothing on it. `true` DROPs (the type is known, so a
   * heuristic pass below would only guess), `false` CONTINUEs. A predicate
   * decides per call, for a language whose miss verdict depends on WHY the walk
   * missed (Python's local binding DROPs an external or unbound type and
   * CONTINUEs a hierarchy it could not close).
   */
  dropOnTypedMiss: boolean | ((type: NominalTypeRef, call: ReceiverCallRef, ctx: CallContext) => boolean);
  /**
   * Whether a file-only target (`targetSymbolId: null` — the type's file is
   * known but nothing declares the member) counts as a miss rather than an
   * answer. Default `false`: the target resolves, as Ruby's typed passes do.
   */
  requirePinnedTarget?: boolean;
}

function hasReceiver(call: CallRef): call is ReceiverCallRef {
  return Boolean(call.receiver);
}

/**
 * The shared verdict of the typed-receiver passes:
 *
 * - `CONTINUE` — no receiver, the language cannot type it, or the type is not
 *   nominal (a union is K2's to fan out; a container, tuple or nil names no
 *   single type);
 * - `resolved(target)` — the member walk answered on the typed ref;
 * - typed miss — `DROP` or `CONTINUE` per {@link ReceiverTypedStrategyOptions}.
 */
export abstract class ReceiverTypedSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly typing: ReceiverTypingPorts,
    private readonly lookup: TypeMemberLookup,
    private readonly options: ReceiverTypedStrategyOptions,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!hasReceiver(call)) return CONTINUE;
    const type = this.typing.typeOfReceiver(call, ctx);
    if (type === null || !typeMemberLookupDefinedFor(type)) return CONTINUE;
    const target = this.lookup.findMember(type, call.member, ctx);
    if (target !== null && (target.targetSymbolId !== null || this.options.requirePinnedTarget !== true)) {
      return resolved(target);
    }
    return this.dropsTypedMiss(type, call, ctx) ? DROP : CONTINUE;
  }

  private dropsTypedMiss(type: NominalTypeRef, call: ReceiverCallRef, ctx: CallContext): boolean {
    const { dropOnTypedMiss } = this.options;
    return typeof dropOnTypedMiss === "function" ? dropOnTypedMiss(type, call, ctx) : dropOnTypedMiss;
  }
}

/**
 * Typed receiver through the language's chain fold: whatever the propagation
 * engine threads a receiver to — a dotted chain, an index access, a bare name a
 * return fact types — the member is resolved on. The entry condition is
 * TYPEDNESS, not receiver shape; the typing port decides what it can type.
 */
export class ChainTypeSymbolResolutionStrategy extends ReceiverTypedSymbolResolutionStrategy {}

/**
 * Receiver bound by the walker — `x = Foo.new`, `x: Foo`, a typed parameter, or
 * a folded call-result binding. Once the typing port answers, the call is the
 * binding's: it resolves on the bound type or takes the typed-miss verdict.
 */
export class LocalBindingSymbolResolutionStrategy extends ReceiverTypedSymbolResolutionStrategy {}

/**
 * Naming-convention receiver typing — a variable named after its class. A
 * guess, so it is held to three gates and never DROPs:
 *
 *  1. the guess comes from the typing port (the language's shape, existence and
 *     no-subtypes gates live there);
 *  2. any real fact channel wins (`isTypedElsewhere` → CONTINUE);
 *  3. the member must PIN a symbol — a file-only target is no evidence the guess
 *     was right, so it CONTINUEs like a miss.
 *
 * A DROP would claim the receiver's type is known-and-foreign, which a
 * convention guess cannot establish.
 *
 * The guess runs before the fact probe: a convention's shape gate rejects most
 * receivers with no lookup at all. Both ports are pure, so the order is cost
 * only and cannot change an answer.
 */
export class ConventionReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly typing: ConventionReceiverTypingPorts,
    private readonly lookup: TypeMemberLookup,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const target = this.findTarget(call, ctx);
    return target === null ? CONTINUE : resolved(target);
  }

  /**
   * The single precise target this pass emits for `call`, or `null` when it
   * cannot answer. Public because a dynamic-dispatch fan-out must know whether
   * the exact path ACTUALLY answers before it fans out — two separate lookups
   * would drift.
   */
  findTarget(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    if (!hasReceiver(call)) return null;
    const type = this.typing.typeOfReceiver(call, ctx);
    if (type === null || !typeMemberLookupDefinedFor(type)) return null;
    if (this.typing.isTypedElsewhere(call, ctx)) return null;
    const target = this.lookup.findMember(type, call.member, ctx);
    // Two distinct declines: the walk offered nothing at all, and the walk
    // offered only the file-only degradation. Gate 3 refuses both.
    if (target === null) return null;
    return target.targetSymbolId === null ? null : target;
  }
}
