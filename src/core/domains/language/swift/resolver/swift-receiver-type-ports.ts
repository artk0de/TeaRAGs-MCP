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
import {
  resolveLocalBinding,
  type CallContext,
  type CallResultBinding,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  propagateReceiverType,
  splitAtBracketDepthZero,
  splitReceiverHops,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import { swiftEnclosingTypeIds, swiftSelfTypeName } from "./swift-enclosing-scope.js";
import type { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { boundedBy } from "./swift-sdk-member-types.js";
import {
  lookupSwiftSymbols,
  lookupSwiftSymbolsByShortName,
  qualifySwiftTypeNameWithin,
} from "./swift-symbol-lookup.js";
import { swiftEnumCasePayloadType, swiftFunctionAliasReturn } from "./swift-type-declarations.js";
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

/**
 * Static properties that, by the Swift API Design Guidelines' naming of
 * shared instances, hold an instance of the type they are read off:
 * `NotificationCenter.default`, `URLSession.shared`, `DispatchQueue.main`,
 * `Locale.current`, `UserDefaults.standard` (bd tea-rags-mcp-y99pg.5).
 *
 * Read only where nothing the project declares answers first — a declared
 * property of that name is typed by its declaration, and a type the project
 * does not declare or extend never seeds a chain at all — so this types the
 * SDK singletons whose members the project adds in extensions, and nothing
 * else.
 */
const SWIFT_SINGLETON_PROPERTIES: ReadonlySet<string> = new Set(["default", "shared", "main", "current", "standard"]);

/** A bare Swift identifier or a closure's implicit `$n` parameter — the only head shapes any channel here can key on. */
const SWIFT_IDENTIFIER = /^(?:[A-Za-z_]\w*|\$\d+)$/;

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
 *   4. A type the project or the SDK substrate DECLARES, named in
 *      UpperCamelCase — the `World.sharedWorld` / `Locale.preferredLanguages`
 *      spelling. Both halves are required: the name test is Swift's API Design
 *      Guidelines (`swift-type-name.ts`), and the declaration probe is what
 *      keeps a global value (`let AF = Session.default`) from reading as a type.
 *
 * A head that is not a bare identifier answers only as one of the shapes that
 * spell their own type: an implicit-self call, a cast, a collection or string
 * literal, or a construction of an SDK type (`String(decoding:as:)`,
 * `Result { … }`, bd tea-rags-mcp-y99pg.25). Anything else — a subscript, a
 * key path, a call whose callee is a value — answers `undefined`.
 */
function swiftHeadType(
  written: string,
  atLine: number,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  // `try` / `await` mark the expression, not its type (bd tea-rags-mcp-y99pg.20).
  const head = written.replace(SWIFT_EFFECT_PREFIX, "");
  const enclosing = swiftSelfTypeName(ctx);
  if (!SWIFT_IDENTIFIER.test(head)) {
    return (
      swiftImplicitSelfCallHeadType(head, atLine, ctx, enclosing, members, ports) ??
      swiftLiteralHeadType(head) ??
      swiftSdkConstructionHeadType(head, members)
    );
  }
  if (head === "self" || head === "Self") {
    if (enclosing === undefined) return undefined;
    return { form: head === "self" ? "instance" : "class", name: enclosing };
  }
  if (head === "super") return undefined;

  const local = swiftLocalValueTypeRef(head, atLine, ctx, ports, members);
  if (local?.form === "instance") return local;

  if (enclosing !== undefined) {
    const fieldType = members.typeOfProperty(enclosing, head, ctx);
    if (fieldType !== undefined) {
      return swiftTypeRefWithArguments(fieldType, members.fieldTypeArguments(enclosing, head, ctx));
    }
    // An implicit-self property the SDK declares on the enclosing type —
    // `allHTTPHeaderFields` inside `extension URLRequest` (bd tea-rags-mcp-y99pg.25).
    const sdkProperty = members.sdkMemberType({ form: "instance", name: enclosing }, head, ctx);
    if (sdkProperty !== undefined) return sdkProperty;
  }

  if (!isSwiftTypeName(head)) return undefined;
  // A type nested in an enclosing type shadows a top-level namesake — Swift's
  // lexical lookup, innermost first (bd tea-rags-mcp-y99pg.20).
  for (const scope of swiftEnclosingTypeIds(ctx)) {
    for (const candidate of [`${scope}.${head}`, scope.endsWith(`.${head}`) ? scope : null]) {
      if (candidate !== null && lookupSwiftSymbols(ctx, candidate).length > 0) {
        return { form: "class", name: candidate };
      }
    }
  }
  if (lookupSwiftSymbols(ctx, head).length > 0) return { form: "class", name: head };
  // A type the SDK declares — `Locale.preferredLanguages` (bd tea-rags-mcp-y99pg.25).
  if (members.isSdkType(head)) return { form: "class", name: head };
  return undefined;
}

/**
 * `String(decoding: data, as: UTF8.self)`, `Result { try … }`,
 * `Result<String, any Error> { … }` as a chain head: a construction of an SDK
 * type is an instance of it, with the generic arguments the spelling states
 * (bd tea-rags-mcp-y99pg.25). The callee must be the WHOLE head up to one
 * argument list and / or trailing closure, so `f(x).y` never reads as one.
 */
function swiftSdkConstructionHeadType(head: string, members: SwiftMemberTypeLookup): TypeRef | undefined {
  const open = head.search(/[({]/);
  if (open <= 0) return undefined;
  const typeText = head.slice(0, open).trim();
  if (!/^_*[A-Z]/.test(typeText) || !swiftHeadEndsAtCallGroups(head, open)) return undefined;
  return members.sdkConstructionType(typeText);
}

/** Whether `head` from `open` on is one `( … )` and / or `{ … }` group each, to its end. */
function swiftHeadEndsAtCallGroups(head: string, open: number): boolean {
  let end = open;
  let groups = 0;
  while (end < head.length) {
    if (head[end] !== "(" && head[end] !== "{") return false;
    const close = closingBracketIndex(head, end);
    if (close === -1 || ++groups > 2) return false;
    end = close + 1;
    while (end < head.length && /\s/.test(head[end])) end++;
  }
  return groups > 0;
}

/** `try` / `try?` / `try!` / `await`, possibly stacked, ahead of a chain head. */
const SWIFT_EFFECT_PREFIX = /^(?:(?:try[?!]?|await)\s+)+/;

/**
 * `validate(statusCode: codes)` as a chain head (bd tea-rags-mcp-y99pg.18): a
 * bare call inside a type is a call of the enclosing type's own method —
 * Swift's `self` is implicit — typed by what that method returns. A head a
 * local names (a closure value) is not a method call.
 */
function swiftImplicitSelfCallHeadType(
  head: string,
  atLine: number,
  ctx: CallContext,
  enclosing: string | undefined,
  members: SwiftMemberTypeLookup,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (enclosing === undefined) return undefined;
  const name = swiftCallHeadCallee(head);
  if (name === undefined || name.startsWith("$")) return undefined;
  if (swiftLocalValueType(name, atLine, ctx, ports, members) !== undefined) return undefined;
  const method = members.memberReturnType(enclosing, name, ctx);
  if (method !== undefined) return method;
  // A stored CLOSURE called in place: `responseHandler { … }` on a
  // `responseHandler: Handler` whose alias is a function type returns what
  // that function type returns (bd tea-rags-mcp-y99pg.22).
  const property = members.typeOfProperty(enclosing, name, ctx);
  // A method the SDK declares on the enclosing type — `enumerated()` inside
  // `extension Collection` (bd tea-rags-mcp-y99pg.25).
  if (property === undefined) return members.sdkMemberType({ form: "instance", name: enclosing }, name, ctx);
  const scopes = swiftEnclosingTypeIds(ctx);
  const alias = swiftFunctionAliasReturn(property, scopes, ctx);
  if (alias === undefined) return undefined;
  return { form: "instance", name: qualifySwiftTypeNameWithin(alias.returned, alias.declaredIn, ctx) };
}

/**
 * The callee of a head that is ONE call — `name(…)`, `name { … }` or
 * `name(…) { … }`, the argument list or trailing closure running to the end
 * of the head — or undefined.
 */
function swiftCallHeadCallee(head: string): string | undefined {
  const open = head.search(/[({]/);
  const name = open > 0 ? head.slice(0, open).trim() : "";
  if (!SWIFT_IDENTIFIER.test(name)) return undefined;
  let end = open;
  while (end < head.length) {
    const close = closingBracketIndex(head, end);
    if (close === -1) return undefined;
    if (close === head.length - 1) return name;
    end = close + 1;
    while (end < head.length && /\s/.test(head[end])) end++;
    if (head[end] !== "{") return undefined;
  }
  return undefined;
}

/** The index of the bracket closing the `(` or `{` at `open`, or -1. */
function closingBracketIndex(text: string, open: number): number {
  const [opener, closer] = text[open] === "{" ? ["{", "}"] : ["(", ")"];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer && --depth === 0) return i;
  }
  return -1;
}

/** `"…"`, `"""…"""`, `#"…"#` — one literal from its opening quote to its closing one. */
const SWIFT_STRING_LITERAL_HEAD = /^(#*)"[\s\S]*"\1$/;

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
  // A string literal, interpolated or raw, is a `String` (bd tea-rags-mcp-y99pg.25).
  if (SWIFT_STRING_LITERAL_HEAD.test(head)) return { form: "instance", name: "String" };
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
  return /^_*[A-Z][\w.]*$/.test(nominal) ? nominal : undefined;
}

/**
 * Swift's `ReceiverTypePorts`. Call ONCE per resolver, over the resolver's own
 * {@link SwiftMemberTypeLookup}, and hand the result to
 * `propagateReceiverType`.
 */
export function createSwiftReceiverTypePorts(members: SwiftMemberTypeLookup): ReceiverTypePorts {
  // Self-referential: a head bound to a value chain is typed by folding that
  // chain through these same ports.
  const ports: ReceiverTypePorts = Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      swiftHeadType(receiver, atLine, ctx, members, ports),
    // See the module docblock: a Swift chain head is a complete answer on its
    // own, so there is nothing for a seed to consume the first link for.
    seedHead: (): undefined => undefined,
    // A hop off a value known only by a bound is known only by one too (bd tea-rags-mcp-y99pg.25).
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined =>
      boundedBy(recv, swiftMemberHopType(recv, member, ctx, members)),
    maxHops: (): number => SWIFT_CHAIN_MAX_HOPS,
    // An argument list carries its own dots (`request(for: task.id)`).
    splitReceiverHops,
  });
  return ports;
}

/** The type one member hop off `recv` denotes — the fold's `memberTypeOf`, before the bound mark. */
function swiftMemberHopType(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  // The field channel records no staticness, so the receiver's form does
  // not select a channel here — a `class` head and an `instance` head read
  // the same property map. Accessing a property always yields a VALUE, so
  // the hop's own form is `instance` either way.
  const fieldType = members.typeOfProperty(recv.name, member, ctx);
  if (fieldType !== undefined) {
    return swiftTypeRefWithArguments(fieldType, members.fieldTypeArguments(recv.name, member, ctx));
  }
  // Not a property: a METHOD hop, typed by what the declaration the call
  // lands on returns. Strict: an ambiguous callee types nothing.
  const returned = members.memberReturnType(recv.name, member, ctx);
  if (returned) return returned;
  // A member the project declares on none of the receiver's types: the
  // SDK's declaration, substituted for the receiver (bd tea-rags-mcp-y99pg.25).
  const declared = members.sdkMemberType(recv, member, ctx);
  if (declared) return declared;
  // `NotificationCenter.default`: a type's own singleton, by convention.
  if (recv.form === "class" && SWIFT_SINGLETON_PROPERTIES.has(member)) return { form: "instance", name: recv.name };
  return undefined;
}

/**
 * The type a LOCAL value name holds at `atLine`, or `undefined`.
 *
 * Two channels, the more recent declaration winning: `localBindings`, which
 * the walker typed, and `callResultBindings`, the SPELLING of a right-hand
 * side whose links live in other files (bd tea-rags-mcp-y99pg.6), folded here
 * through `ports` with the whole run in scope. The spelling is folded at its
 * own line and a spelling is only visible STRICTLY below its line, so
 * `var request = request.adapted()` reads the `request` declared above it,
 * and every nested fold moves to an earlier line — the recursion terminates.
 *
 * A spelling that folds to nothing answers `undefined`, exactly as an
 * unrecorded local did before the channel existed, and the callers keep their
 * fallbacks. Swift scoping says such a local SHADOWS a same-named property;
 * dropping on it was measured and cost correct edges
 * (`let example = wrapper.example` beside a stored `example`), because a local
 * named after a property overwhelmingly holds the property's type.
 */
export function swiftLocalValueType(
  name: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): string | undefined {
  const type = swiftLocalValueTypeRef(name, atLine, ctx, ports, members);
  return type?.form === "instance" ? type.name : undefined;
}

/**
 * {@link swiftLocalValueType} with the generic arguments a folded spelling
 * carries (`Result<URLRequest, Error>`, bd tea-rags-mcp-y99pg.25) — what a
 * chain HEAD reads, so an SDK member on it can substitute them.
 */
function swiftLocalValueTypeRef(
  name: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const typed = resolveLocalBinding(ctx.localBindings, name, atLine);
  let spelled: CallResultBinding | undefined;
  for (const binding of identifierEntry(ctx.callResultBindings, name) ?? []) {
    if (!swiftBindingVisible(binding, name, atLine)) continue;
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < atLine) continue;
    if (spelled === undefined || binding.line > spelled.line) spelled = binding;
  }
  if (spelled === undefined || (typed !== undefined && typed.line >= spelled.line)) {
    return typed === undefined ? undefined : { form: "instance", name: typed.type };
  }
  if (spelled.closureParameter !== undefined) {
    return swiftClosureParameterType(spelled.callee, spelled.closureParameter, spelled.line, ctx, ports, members);
  }
  const folded = propagateReceiverType(spelled.callee, spelled.line, ctx, ports);
  if (folded?.form !== "instance") return undefined;
  // `case .group(let g)`: the subject's enum says what the slot carries (bd tea-rags-mcp-y99pg.16).
  if (spelled.enumPayload !== undefined) {
    const payload = swiftEnumCasePayloadType(folded.name, spelled.enumPayload.caseName, spelled.enumPayload.index, ctx);
    return payload === undefined ? undefined : { form: "instance", name: payload };
  }
  return folded;
}

/**
 * Whether a spelling binding is in scope at `atLine`. A call result is visible
 * strictly below its line (`var request = request.adapted()` reads the outer
 * `request`). A closure's `$n` parameter is visible on the line that opens the
 * closure too — `mutableState.write { $0.update() }` — since nothing on that
 * line outside the closure can name `$n`. A NAMED closure parameter is not:
 * `mutableState.write { mutableState in` names the receiver on the very line
 * the parameter shadows it, and a line cannot tell the two apart.
 */
function swiftBindingVisible(binding: CallResultBinding, name: string, atLine: number): boolean {
  const inclusive = binding.closureParameter !== undefined && name.startsWith("$");
  return inclusive ? binding.line <= atLine : binding.line < atLine;
}

/**
 * The type of the `index`-th parameter of a closure passed to `callee` on
 * `line` (bd tea-rags-mcp-y99pg.13) — what the callee's declaration says the
 * closure takes: a concrete type as written, or one of the declaring type's
 * generic parameters bound by the receiver's type arguments
 * (`mutableState.write { … }` on `mutableState: Protected<MutableState>`
 * with `write(_: (inout Value) -> U)` → `MutableState`).
 *
 * The receiver is folded one line ABOVE the closure: its parameters are in
 * scope on their own line, and `mutableState.write { mutableState in` names
 * the receiver and the parameter alike. A generic slot is bound by the type
 * arguments the fold carried to the receiver, else — for a receiver that is a
 * stored property of the enclosing type (`field`, `self.field`) — by the ones
 * the property declares.
 *
 * A member the project declares on none of the receiver's types is read off
 * the SDK substrate instead (bd tea-rags-mcp-y99pg.25): `requests.forEach`
 * on a `Set<Request>` calls its closure with a `Request`, and
 * `result.mapError` on a `Result` with its `Failure`.
 */
function swiftClosureParameterType(
  callee: string,
  index: number,
  line: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const cut = callee.lastIndexOf(".");
  if (cut === 0) return undefined;
  if (cut === -1) return swiftBareCalleeClosureParameterType(callee, index, line, ctx, ports, members);
  const receiver = callee.slice(0, cut);
  const member = callee.slice(cut + 1);
  const foldLine = line - 1;
  const type = propagateReceiverType(receiver, foldLine, ctx, ports);
  if (type === undefined || (type.form !== "instance" && type.form !== "class")) return undefined;
  const signature = members.closureParameterTypes(type.name, member, ctx);
  if (signature === undefined) return members.sdkClosureParameterType(type, member, index, ctx);
  const declared = signature.types?.[index];
  if (declared === null || declared === undefined) return undefined;
  const slot = signature.genericParameters.indexOf(declared);
  if (slot === -1) return boundedBy(type, { form: "instance", name: declared });
  const carried = type.args?.[slot];
  if (carried !== undefined) return boundedBy(type, carried);
  const field = receiver.startsWith("self.") ? receiver.slice("self.".length) : receiver;
  if (!SWIFT_IDENTIFIER.test(field) || field === "self") return undefined;
  const enclosing = swiftSelfTypeName(ctx);
  if (enclosing === undefined) return undefined;
  // A bare receiver may be a LOCAL shadowing the property, whose type
  // arguments are not the property's. A binding of the property's own type is
  // the property itself: a call attributed to its type's chunk (a `deinit`,
  // an initializer the chunker does not split out) sees it as a binding.
  if (field === receiver) {
    const local = swiftLocalValueType(field, foldLine, ctx, ports, members);
    if (local !== undefined && local !== members.typeOfProperty(enclosing, field, ctx)) return undefined;
  }
  const argument = members.fieldTypeArguments(enclosing, field, ctx)?.[slot];
  return argument === null || argument === undefined ? undefined : { form: "instance", name: argument };
}

/**
 * The type of the `index`-th parameter of a closure passed to a BARE callee
 * (bd tea-rags-mcp-y99pg.29), in Swift's own lookup order for an unqualified
 * name:
 *
 *   1. an implicit-self METHOD of the enclosing type — the project's
 *      declaration first, then one the SDK declares on the type's hierarchy
 *      (`compactMap { … }` inside a `Publisher`). A member either source
 *      declares shadows every module-level function of that name, so a
 *      declaration that types nothing here ends the lookup;
 *   2. a module-level SDK function (`withCheckedContinuation { continuation in`),
 *      unless the project declares a module-level namesake, which shadows it.
 *
 * A name a local binds is a closure VALUE being called, and types nothing. So
 * does a project method's closure slot naming one of its type's generic
 * parameters: nothing at a bare call states the enclosing type's arguments.
 */
function swiftBareCalleeClosureParameterType(
  callee: string,
  index: number,
  line: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const foldLine = line - 1;
  if (isSwiftTypeName(callee)) {
    return swiftConstructionClosureParameterType(callee, index, foldLine, ctx, ports, members);
  }
  if (!SWIFT_IDENTIFIER.test(callee) || callee.startsWith("$")) return undefined;
  if (resolveLocalBinding(ctx.localBindings, callee, foldLine) !== undefined) return undefined;
  if (swiftLocalValueType(callee, foldLine, ctx, ports, members) !== undefined) return undefined;
  const enclosing = swiftSelfTypeName(ctx);
  if (enclosing !== undefined) {
    const signature = members.closureParameterTypes(enclosing, callee, ctx);
    if (signature !== undefined) {
      const declared = signature.types?.[index];
      if (declared === null || declared === undefined || signature.genericParameters.includes(declared)) {
        return undefined;
      }
      return { form: "instance", name: declared };
    }
    if (members.memberReach(enclosing, callee, ctx).declared) return undefined;
    if (members.sdkDeclaresMember(enclosing, callee, ctx)) {
      return members.sdkClosureParameterType({ form: "instance", name: enclosing }, callee, index, ctx);
    }
  }
  if (lookupSwiftSymbolsByShortName(ctx, callee).some((def) => def.scope.length === 0)) return undefined;
  return members.sdkFunctionClosureParameterType(callee, index);
}

/**
 * The closure parameter of a CONSTRUCTION — `StreamOf(bufferingPolicy:) { continuation in`,
 * `AsyncStream { continuation in` (bd tea-rags-mcp-y99pg.29): what the
 * constructed type's `init` says its closure takes — the project's
 * declaration first, else the SDK's. A slot naming one of the type's own
 * generic parameters types nothing: the construction's arguments are not
 * folded here.
 */
function swiftConstructionClosureParameterType(
  typeText: string,
  index: number,
  foldLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const type = propagateReceiverType(typeText, foldLine, ctx, ports);
  if (type?.form !== "class") return undefined;
  const signature = members.closureParameterTypes(type.name, "init", ctx);
  if (signature !== undefined) {
    const declared = signature.types?.[index];
    if (declared === null || declared === undefined || signature.genericParameters.includes(declared)) return undefined;
    return { form: "instance", name: declared };
  }
  return members.sdkClosureParameterType(type, "init", index, ctx);
}

/**
 * A field's declared type with the generic arguments its declaration spells
 * (`activeRequests: Set<Request>` → `Set` of `Request`), attached only when
 * every one of them is known (bd tea-rags-mcp-y99pg.25).
 */
function swiftTypeRefWithArguments(name: string, args: readonly (string | null)[] | undefined): TypeRef {
  if (args === undefined || args.length === 0 || args.some((arg) => arg === null)) return { form: "instance", name };
  return { form: "instance", name, args: args.map((arg) => ({ form: "instance", name: arg ?? "" })) };
}
