/**
 * Swift's answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`) — what lets `self.session.adapter`
 * and `World.sharedWorld` carry a type into the member lookup.
 *
 * The channels are the three the Swift walker publishes about types:
 * per-chunk `localBindings` (a typed parameter, an annotated `let`, a CapWords
 * initializer), the field types it publishes under BOTH addresses — the
 * per-file `classFieldTypes` and the run-global `classFieldTypesByClassKey` —
 * both read through the one {@link SwiftMemberTypeLookup} the resolver owns,
 * and the run-global `structuredReturnTypes` (bd tea-rags-mcp-kkwg3):
 *
 *   - **A CALL hop is typed by what its callee RETURNS.**
 *     `stateProvider.request(for: task).didFailTask()` resolves `request` to
 *     the declaration the call lands on — own type, then superclass, exactly as
 *     a call there would — and reads that symbol's published return. A first
 *     build of this channel measured ZERO edges and shipped nothing; it pays
 *     now because the two things it waited on landed first — a Swift grammar
 *     that parses the files these chains live in, and inherited-member
 *     dispatch. The hop split is the bracket-aware one
 *     (`splitReceiverHops`), because an argument list carries its own dots
 *     (`request(for: task.id)`), and a plain `split(".")` shreds it.
 *   - **A cast or a literal head names its own type** (bd tea-rags-mcp-ll93g):
 *     `(headers as HTTPHeaders).map`, `[a, b].joinedWithAmpersands`. See
 *     {@link swiftLiteralHeadType}.
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
 * per-resolver lookup, whose memos belong to the resolver.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import { resolveLocalBindingType, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  splitAtBracketDepthZero,
  splitReceiverHops,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import { swiftSelfTypeName } from "./swift-enclosing-scope.js";
import type { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { lookupSwiftSymbols } from "./swift-symbol-lookup.js";
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
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  if (!SWIFT_IDENTIFIER.test(head)) return swiftLiteralHeadType(head);
  const enclosing = swiftSelfTypeName(ctx);
  if (head === "self" || head === "Self") {
    if (enclosing === undefined) return undefined;
    return { form: head === "self" ? "instance" : "class", name: enclosing };
  }
  if (head === "super") return undefined;

  const bound = resolveLocalBindingType(ctx.localBindings, head, atLine);
  if (bound !== undefined) return { form: "instance", name: bound };

  if (enclosing !== undefined) {
    const fieldType = members.typeOfProperty(enclosing, head, ctx);
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
  }

  if (isSwiftTypeName(head) && lookupSwiftSymbols(ctx, head).length > 0) return { form: "class", name: head };
  return undefined;
}

/** `(expr as T)`, `(expr as? T)`, `(expr as! T)` — `normalizeSwiftReceiver` may already have dropped the `?` / `!`. */
const SWIFT_CAST_HEAD = /^\(([\s\S]+)\s+as[?!]?\s+([\s\S]+)\)$/;

/**
 * The type a head that is not a VALUE NAME spells out itself — the receiver
 * shapes the kernel's plain split shredded and no channel keyed (bd
 * tea-rags-mcp-ll93g):
 *
 *   - a parenthesised CAST names its target type right there:
 *     `(allHeaderFields as [String: String]).map` is a `Dictionary`;
 *   - an array literal `[a, b]` is an `Array`, a dictionary literal `[k: v]`
 *     (or `[:]`) a `Dictionary` — Swift's own names for the two, which is what
 *     a project `extension Array { … }` composes its members under.
 *
 * Everything else — a trailing-closure head (`Result { … }`), a call head, a
 * key path — answers `undefined`, which is the one answer that cannot be wrong.
 */
function swiftLiteralHeadType(head: string): TypeRef | undefined {
  const cast = SWIFT_CAST_HEAD.exec(head);
  const literal = head.startsWith("[") && head.endsWith("]") ? head : undefined;
  const typeText = cast ? cast[2].trim() : literal;
  if (typeText === undefined) return undefined;
  const name = swiftTypeTextName(typeText);
  return name === undefined ? undefined : { form: "instance", name };
}

/**
 * The nominal a type (or collection literal) TEXT names: `Foo`, `Foo?`,
 * `Foo<Bar>`, `any Foo`, `Outer.Inner`; `[T]` → `Array`, `[K: V]` →
 * `Dictionary`. The colon test runs at bracket depth 1, so `[[String: Int]]`
 * stays an `Array`.
 */
function swiftTypeTextName(text: string): string | undefined {
  const trimmed = text.replace(/^any\s+/, "").replace(/[?!]+$/, "");
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return undefined;
    return splitAtBracketDepthZero(trimmed.slice(1, -1), ":").length > 1 ? "Dictionary" : "Array";
  }
  const nominal = trimmed.replace(/<[\s\S]*>$/, "");
  return /^[A-Z][\w.]*$/.test(nominal) ? nominal : undefined;
}

/**
 * Swift's `ReceiverTypePorts`. Call ONCE per resolver, over the resolver's own
 * {@link SwiftMemberTypeLookup}, and hand the result to
 * `propagateReceiverType`.
 */
export function createSwiftReceiverTypePorts(members: SwiftMemberTypeLookup): ReceiverTypePorts {
  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      swiftHeadType(receiver, atLine, ctx, members),
    // See the module docblock: a Swift chain head is a complete answer on its
    // own, so there is nothing for a seed to consume the first link for.
    seedHead: (): undefined => undefined,
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined => {
      if (recv.form !== "class" && recv.form !== "instance") return undefined;
      // The field channel records no staticness, so the receiver's form does
      // not select a channel here — a `class` head and an `instance` head read
      // the same property map. Accessing a property always yields a VALUE, so
      // the hop's own form is `instance` either way.
      const fieldType = members.typeOfProperty(recv.name, member, ctx);
      if (fieldType !== undefined) return { form: "instance", name: fieldType };
      // Not a property: a METHOD hop, typed by what the declaration the call
      // lands on returns. Strict: an ambiguous callee types nothing.
      const callee = members.memberOn(recv.name, member, ctx, "strict")?.targetSymbolId;
      return callee ? identifierEntry(ctx.structuredReturnTypes, callee) : undefined;
    },
    maxHops: (): number => SWIFT_CHAIN_MAX_HOPS,
    // An argument list carries its own dots (`request(for: task.id)`).
    splitReceiverHops,
  });
}
