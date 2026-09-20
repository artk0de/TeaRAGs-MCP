/**
 * Swift's answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`) — what lets `self.session.adapter`
 * and `World.sharedWorld` carry a type into the member lookup.
 *
 * The channels are the only two the Swift walker publishes about types:
 * per-chunk `localBindings` (a typed parameter, an annotated `let`, a CapWords
 * initializer) and the field types it publishes under BOTH addresses — the
 * per-file `classFieldTypes` and the run-global `classFieldTypesByClassKey`,
 * which `SwiftTypeFieldIndex` unions back into one map per type name. There is
 * deliberately no third:
 *
 *   - **No return-type channel.** The walker collects declared returns while it
 *     walks (`collectSwiftFileTypeEvidence`) and spends them typing locals, but
 *     it publishes neither `functionReturnTypes` nor `structuredReturnTypes`.
 *     So `a.makeThing().run()` is untyped here, and typing it is a WALKER
 *     increment, not a port this file could grow.
 *   - **No module-alias seed.** `seedHead` answers `undefined` outright. A head
 *     Swift can type is a value, `self` / `Self`, or a type name, and each of
 *     the three is a complete answer on its own — none of them needs to consume
 *     the first link to be typed the way Python's `mod.Cls()` does. That is the
 *     same fact `swift-resolver.ts` states as "there is deliberately no
 *     import-receiver pass": `import Foundation` names a MODULE and never a
 *     symbol, so there is no alias for a seed to resolve.
 *
 * Built ONCE per resolver and frozen: the fold runs per call site and threads
 * `ctx` as an argument precisely so nothing is allocated there. The factory
 * exists rather than a module singleton because the ports close over the
 * ancestor-linearizer memo below, which must belong to the resolver.
 */

import { resolveLocalBindingType, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  type AncestorLinearizer,
} from "../../kernel/ancestor-walk.js";
import type { ReceiverTypePorts } from "../../kernel/receiver-type-propagation.js";
import { RunScopedMemo } from "../../kernel/run-scoped-memo.js";
import { SWIFT_ANCESTOR_POLICY } from "./swift-ancestor-policy.js";
import { lookupSwiftSymbols } from "./swift-symbol-lookup.js";
import { SwiftTypeFieldIndex } from "./swift-type-field-index.js";
import { isSwiftTypeName } from "./swift-type-name.js";

/**
 * How many LINKS a receiver may carry and still be folded.
 *
 * Three, against the kernel's default of four, and the number is measured
 * rather than picked: across Alamofire and Quick, 192 of the 195 unresolved
 * chained receivers carry exactly ONE link, two carry two, and one carries
 * three. So three covers every shape either corpus contains, with nothing left
 * to buy above it.
 *
 * What a fourth hop would cost is the reason not to take it anyway. Every hop
 * here is a `classFieldTypes` read keyed by a type's SHORT name — no file, no
 * module — so the chance that some link resolves against a namesake compounds
 * with depth, and unlike Python there is no import mapper downstream to catch
 * a type that was never in the project at all. A chain past the cap is left
 * untyped, which is the one answer that cannot be wrong.
 */
const SWIFT_CHAIN_MAX_HOPS = 3;

/** A bare Swift identifier — the only head shape any channel here can key on. */
const SWIFT_IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * The type a property named `member` holds on `typeName`, read on the type
 * itself and then up its superclass chain.
 *
 * TWO sources per candidate, in this order and not the other:
 *
 *   1. `ctx.classFieldTypes` — the CALLER's own file. It is the source text the
 *      call sits in rather than anything folded across the run, and reading it
 *      first is what makes this change unable to move an edge that resolves
 *      today.
 *   2. {@link SwiftTypeFieldIndex} — every other Swift file of the run, unioned
 *      per type name out of `classFieldTypesByClassKey`. Without it the fold
 *      dies at hop 2 on any real corpus, because hop 1's type is declared in
 *      its own file, not in the caller's.
 *
 * The ancestor walk is not an extra either: Swift's stored properties are
 * routinely declared on a base class and used from a subclass, and the
 * own-type-only read is what left `self.eventMonitor` (declared on `Request`,
 * called from `DataRequest`) untyped. It reuses the driver and the policy
 * `super` already walks (`kernel/ancestor-walk.ts`,
 * {@link SWIFT_ANCESTOR_POLICY}) rather than re-deriving the order, so the two
 * passes can never disagree about what a class's superclass is. A class with no
 * `classExtends` entry linearizes to itself alone, which is exactly the
 * own-type read this replaces.
 */
function swiftFieldTypeOf(
  typeName: string,
  member: string,
  ctx: CallContext,
  linearizer: AncestorLinearizer<CallContext>,
  index: SwiftTypeFieldIndex,
): string | undefined {
  const scan = findMemberInAncestorChain(
    typeName,
    linearizer,
    (candidate) => ctx.classFieldTypes?.[candidate]?.[member] ?? index.fieldsOf(candidate, ctx)?.[member] ?? null,
  );
  return scan.target ?? undefined;
}

/**
 * The type a chain HEAD denotes. Four arms, in Swift's own lookup order:
 *
 *   1. `self` / `Self` — the enclosing type, as an instance and as the type
 *      itself. `super` is deliberately NOT here: `super.<field>` is the same
 *      storage `self.<field>` names (Swift forbids a stored property from
 *      overriding one), so the arm would buy nothing, and the `super` receiver
 *      belongs to the pass at chain index 0.
 *   2. A LOCAL in force at the call line, read position-aware — a local
 *      declaration shadows a stored property of the same name, which is the
 *      language's scoping rule and not a preference.
 *   3. A stored property of the enclosing type. Swift's `self` is implicit, so
 *      a bare head is a property access wherever it is not a local.
 *   4. A type the project DECLARES, named in UpperCamelCase — the
 *      `World.sharedWorld` spelling. Both halves are required: the name test
 *      is Swift's API Design Guidelines (`swift-type-name.ts`), and the
 *      declaration probe is what keeps a Foundation type the index has never
 *      seen from seeding a chain.
 *
 * A head that is not a bare identifier is declined before any of them. A
 * receiver whose head carries a call, a subscript or a trailing closure —
 * `Result { … }.mapError`, `(headers as [String: String]).map` — has no
 * channel that could type it, and the default hop split shreds it into
 * segments that would only produce a wrong lookup.
 */
function swiftHeadType(
  head: string,
  atLine: number,
  ctx: CallContext,
  linearizer: AncestorLinearizer<CallContext>,
  index: SwiftTypeFieldIndex,
): TypeRef | undefined {
  if (!SWIFT_IDENTIFIER.test(head)) return undefined;
  const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
  if (head === "self" || head === "Self") {
    if (enclosing === undefined) return undefined;
    return { form: head === "self" ? "instance" : "class", name: enclosing };
  }
  if (head === "super") return undefined;

  const bound = resolveLocalBindingType(ctx.localBindings, head, atLine);
  if (bound !== undefined) return { form: "instance", name: bound };

  if (enclosing !== undefined) {
    const fieldType = swiftFieldTypeOf(enclosing, head, ctx, linearizer, index);
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
  }

  if (isSwiftTypeName(head) && lookupSwiftSymbols(ctx, head).length > 0) return { form: "class", name: head };
  return undefined;
}

/**
 * Swift's `ReceiverTypePorts`. Call ONCE per resolver and hand the result to
 * `propagateReceiverType`.
 *
 * The linearizer memo is scoped through {@link RunScopedMemo} rather than a
 * bare `WeakMap`, for the reason `swift-super.ts` states: a resolver is cached
 * by `LanguageFactory.create` for the factory's lifetime, so a memo keyed on
 * context identity alone would serve one run's hierarchy to the next (bd
 * tea-rags-mcp-z99hp).
 */
export function createSwiftReceiverTypePorts(): ReceiverTypePorts {
  const linearizers = new RunScopedMemo<CallContext, AncestorLinearizer<CallContext>>();
  // The run's cross-file field union, built once per run behind its own memo.
  const index = new SwiftTypeFieldIndex();
  const linearizerFor = (ctx: CallContext): AncestorLinearizer<CallContext> => {
    const hit = linearizers.get(ctx.runScope, ctx);
    if (hit !== undefined) return hit;
    const fresh = createAncestorLinearizer(ctx, SWIFT_ANCESTOR_POLICY);
    linearizers.set(ctx.runScope, ctx, fresh);
    return fresh;
  };

  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      swiftHeadType(receiver, atLine, ctx, linearizerFor(ctx), index),
    // See the module docblock: a Swift chain head is a complete answer on its
    // own, so there is nothing for a seed to consume the first link for.
    seedHead: (): undefined => undefined,
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined => {
      if (recv.form !== "class" && recv.form !== "instance") return undefined;
      // `classFieldTypes` records no staticness, so the receiver's form does
      // not select a channel here — a `class` head and an `instance` head read
      // the same property map. Accessing a property always yields a VALUE, so
      // the hop's own form is `instance` either way.
      const fieldType = swiftFieldTypeOf(recv.name, member, ctx, linearizerFor(ctx), index);
      return fieldType === undefined ? undefined : { form: "instance", name: fieldType };
    },
    maxHops: (): number => SWIFT_CHAIN_MAX_HOPS,
  });
}
