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
  type CallRef,
  type CallResultBinding,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  propagateReceiverType,
  splitAtBracketDepthZero,
  splitReceiverHops,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import { parseSwiftTypeText } from "../vocabulary/swift-type-text.js";
import { swiftEnclosingTypeIds, swiftSelfTypeName } from "./swift-enclosing-scope.js";
import type { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { boundedBy, type SwiftNominalTypeRef } from "./swift-sdk-member-types.js";
import {
  lookupSwiftSymbols,
  lookupSwiftSymbolsByShortName,
  qualifySwiftTypeName,
  qualifySwiftTypeNameWithin,
} from "./swift-symbol-lookup.js";
import { swiftDeclaringFiles, swiftEnumCasePayloadType, swiftFunctionAliasReturn } from "./swift-type-declarations.js";
import { isSwiftTypeName } from "./swift-type-name.js";

/**
 * How many LINKS a receiver may carry and still be folded.
 *
 * Five, and the number is measured rather than picked. It was three while
 * every hop was a `classFieldTypes` read keyed by a type's SHORT name — no
 * file, no module — where the chance that some link resolves against a
 * namesake compounds with depth. Two things moved since: the SDK substrate
 * answers a link on an SDK type from its declaration, exactly (bd
 * tea-rags-mcp-y99pg.25), and the one receiver past three links that either
 * corpus contains is such a chain — Alamofire's default User-Agent,
 * `ProcessInfo.processInfo.arguments.first?.split(separator: "/").last`, five
 * links, all SDK. Across Alamofire and Quick every other chained receiver
 * carries at most three, so five changes no other site (bd
 * tea-rags-mcp-y99pg.34).
 *
 * The namesake risk stays the reason not to raise it further on speculation:
 * a project link past five is still a short-name read, and a chain past the
 * cap is left untyped, which is the one answer that cannot be wrong.
 */
const SWIFT_CHAIN_MAX_HOPS = 5;

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

/** `$name` — a property wrapper's projected value, the property's name captured (bd tea-rags-mcp-y99pg.33). */
const SWIFT_PROJECTED_VALUE = /^\$([A-Za-z_]\w*)$/;

/**
 * What `$field` on a value of `owner` denotes (bd tea-rags-mcp-y99pg.33): the
 * `projectedValue` of the property's wrapper, which Swift synthesizes
 * `$field` from — `Published<Value>.Publisher` for `@Published`. A property
 * with no wrapper, or a wrapper that projects nothing, types nothing.
 */
function swiftProjectedValueType(
  owner: Extract<TypeRef, { form: "class" | "instance" }>,
  field: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const wrapper = members.propertyWrapperOf(owner.name, field, ctx);
  if (wrapper === undefined) return undefined;
  return boundedBy(owner, swiftMemberHopType({ form: "instance", name: wrapper }, "projectedValue", ctx, members));
}

/**
 * The type a chain HEAD denotes. Six arms, in Swift's own lookup order:
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
 *   4. A type the PROJECT declares, named in UpperCamelCase — the
 *      `World.sharedWorld` spelling. Both halves are required: the name test is
 *      Swift's API Design Guidelines (`swift-type-name.ts`), and the
 *      declaration probe is what keeps a global value from reading as a type.
 *   5. A MODULE-LEVEL value (`let AF = Session.default`, bd
 *      tea-rags-mcp-y99pg.30) — module scope is the outermost one, and a
 *      module's own declaration shadows an imported type.
 *   6. A type the SDK substrate declares — `Locale.preferredLanguages`.
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
  keepsOptionals = false,
): TypeRef | undefined {
  // `try` / `await` mark the expression, not its type (bd tea-rags-mcp-y99pg.20);
  // a head a chain continues on the next line carries that line break.
  const head = written.replace(SWIFT_EFFECT_PREFIX, "").trim();
  const enclosing = swiftSelfTypeName(ctx);
  // `$result`: the enclosing type's own property, projected (bd tea-rags-mcp-y99pg.33).
  const projected = SWIFT_PROJECTED_VALUE.exec(head);
  if (projected !== null) {
    return enclosing === undefined
      ? undefined
      : swiftProjectedValueType({ form: "instance", name: enclosing }, projected[1], ctx, members);
  }
  if (!SWIFT_IDENTIFIER.test(head)) {
    return (
      swiftImplicitSelfCallHeadType(head, atLine, ctx, enclosing, members, ports) ??
      swiftLiteralHeadType(head) ??
      swiftNilCoalescingHeadType(head, atLine, ctx, ports) ??
      swiftProjectConstructionHeadType(head, ctx) ??
      swiftSdkConstructionHeadType(head, members)
    );
  }
  if (head === "self" || head === "Self") {
    if (enclosing === undefined) return undefined;
    // `self` carries what a constrained extension binds (bd tea-rags-mcp-y99pg.34).
    return head === "self" ? members.selfType(enclosing, atLine, ctx) : { form: "class", name: enclosing };
  }
  if (head === "super") return undefined;

  const local = swiftLocalValueTypeRef(head, atLine, ctx, ports, members, keepsOptionals);
  if (local?.form === "instance") return swiftPropertyArgumentsOnLocal(local, head, enclosing, ctx, members);

  if (enclosing !== undefined) {
    const fieldType = members.typeOfProperty(enclosing, head, ctx);
    if (fieldType !== undefined) {
      const field = swiftTypeRefWithArguments(fieldType, members.fieldTypeArguments(enclosing, head, ctx));
      return keepsOptionals && members.isOptionalProperty(enclosing, head, ctx) ? swiftOptionalOf(field) : field;
    }
    // A property typed as a generic parameter a constrained extension binds (bd tea-rags-mcp-y99pg.34).
    const bound = members.genericFieldType(members.selfType(enclosing, atLine, ctx), head, ctx);
    if (bound !== undefined) return bound;
    // An implicit-self property the SDK declares on the enclosing type —
    // `allHTTPHeaderFields` inside `extension URLRequest` (bd tea-rags-mcp-y99pg.25).
    const selfRef = { form: "instance" as const, name: enclosing };
    const sdkProperty = keepsOptionals
      ? members.sdkMemberTypeKeepingOptionals(selfRef, head, ctx)
      : members.sdkMemberType(selfRef, head, ctx);
    if (sdkProperty !== undefined) return sdkProperty;
  }

  const projectType = swiftVisibleProjectType(head, ctx);
  if (projectType !== undefined) return projectType;
  // A module-level value: past every nearer scope, and ahead of the SDK's
  // types, which an own declaration shadows (bd tea-rags-mcp-y99pg.30).
  const moduleValue = swiftModuleValueReceiverType(head, atLine, ctx, members, ports);
  if (moduleValue !== undefined) return moduleValue;
  // A type the SDK declares — `Locale.preferredLanguages` (bd tea-rags-mcp-y99pg.25).
  if (isSwiftTypeName(head) && members.isSdkType(head)) return { form: "class", name: head };
  return undefined;
}

/**
 * A local bound with the enclosing type's property's OWN type is that property
 * — a call attributed to its type's chunk (a `deinit`, an initializer the
 * chunker does not split out) sees the stored property as a binding — so it
 * carries the generic arguments the property declares (`mutableState:
 * Protected<MutableState>`, bd tea-rags-mcp-y99pg). The rule
 * {@link swiftClosureParameterType} applies to a closure's receiver, applied
 * to a chain head.
 */
function swiftPropertyArgumentsOnLocal(
  local: SwiftNominalTypeRef,
  head: string,
  enclosing: string | undefined,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): TypeRef {
  if (local.args !== undefined || enclosing === undefined) return local;
  if (members.typeOfProperty(enclosing, head, ctx) !== local.name) return local;
  const args = members.fieldTypeArguments(enclosing, head, ctx);
  return args === undefined ? local : swiftTypeRefWithArguments(local.name, args);
}

/**
 * A project type `name` denotes from the caller's scope, as a `class`
 * reference: a type nested in an enclosing type shadows a top-level namesake —
 * Swift's lexical lookup, innermost first (bd tea-rags-mcp-y99pg.20).
 */
function swiftVisibleProjectType(name: string, ctx: CallContext): TypeRef | undefined {
  if (!isSwiftTypeName(name)) return undefined;
  for (const scope of swiftEnclosingTypeIds(ctx)) {
    for (const candidate of [`${scope}.${name}`, scope.endsWith(`.${name}`) ? scope : null]) {
      if (candidate !== null && lookupSwiftSymbols(ctx, candidate).length > 0) {
        return { form: "class", name: candidate };
      }
    }
  }
  return lookupSwiftSymbols(ctx, name).length > 0 ? { form: "class", name } : undefined;
}

/**
 * The type a single-identifier receiver holds as a MODULE-LEVEL value (bd
 * tea-rags-mcp-y99pg.30) — only when nothing nearer names it: a local in scope
 * at `atLine` (typed or not — Swift's shadowing does not depend on what the
 * index could type), a stored property of the enclosing type, or a project
 * type visible from the caller.
 */
export function swiftModuleValueReceiverType(
  name: string,
  atLine: number,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (resolveLocalBinding(ctx.localBindings, name, atLine) !== undefined) return undefined;
  for (const binding of identifierEntry(ctx.callResultBindings, name) ?? []) {
    if (swiftBindingVisible(binding, name, atLine) && (binding.scopeEndLine ?? atLine) >= atLine) return undefined;
  }
  const enclosing = swiftSelfTypeName(ctx);
  if (enclosing !== undefined && members.typeOfProperty(enclosing, name, ctx) !== undefined) return undefined;
  if (swiftVisibleProjectType(name, ctx) !== undefined) return undefined;
  return members.moduleValues.typeOf(name, ctx, ports);
}

/**
 * `String(decoding: data, as: UTF8.self)`, `Result { try … }`,
 * `Result<String, any Error> { … }` as a chain head: a construction of an SDK
 * type is an instance of it, with the generic arguments the spelling states
 * (bd tea-rags-mcp-y99pg.25). The callee must be the WHOLE head up to one
 * argument list and / or trailing closure, so `f(x).y` never reads as one.
 */
/**
 * `ClockStore(defaults: defaults)`, `Migration(\n  a: 1\n)`, `Box<Int> { … }` as
 * a chain head: a construction of a PROJECT type is an instance of the type
 * the name denotes from the caller's scope (bd tea-rags-mcp-y99pg.39). Only a
 * name the run records as a type — a declaration or a re-opening — so an
 * UpperCamelCase free function never reads as one; the callee must be the
 * whole head up to its argument list and / or trailing closure.
 */
function swiftProjectConstructionHeadType(head: string, ctx: CallContext): TypeRef | undefined {
  const open = head.search(/[({]/);
  if (open <= 0 || !swiftHeadEndsAtCallGroups(head, open)) return undefined;
  const typeText = head
    .slice(0, open)
    .trim()
    .replace(/<[\s\S]*>$/, "");
  const type = swiftVisibleProjectType(typeText, ctx);
  if (type?.form !== "class" || swiftDeclaringFiles(type.name, ctx) === undefined) return undefined;
  return { form: "instance", name: type.name };
}

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
 * The operand of a parenthesised cast head — `specClass` in
 * `(specClass as AnyClass)` — or `undefined` for any other head. A cast
 * changes the static type only: the value, and so the class the runtime
 * dispatches on, is the operand's (bd tea-rags-mcp-y99pg.35).
 */
export function swiftCastOperand(head: string): string | undefined {
  const cast = SWIFT_CAST_HEAD.exec(head);
  return cast ? cast[1].trim() : undefined;
}

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
  const range = swiftRangeHeadType(head);
  if (range !== undefined) return range;
  const cast = SWIFT_CAST_HEAD.exec(head);
  const literal = head.startsWith("[") && head.endsWith("]") ? head : undefined;
  const typeText = cast ? cast[2].trim() : literal;
  if (typeText === undefined) return undefined;
  const name = swiftTypeTextName(typeText);
  return name === undefined ? undefined : { form: "instance", name };
}

/**
 * The range a parenthesised range head builds (bd tea-rags-mcp-y99pg.39):
 * `(0..<n)` is a `Range`, `("a"..."z")` a `ClosedRange` — the operator names
 * the type whatever the bounds are. Only a two-sided range whose operator sits
 * at the parentheses' own depth, outside any string: `(f(0..<3))` is a call.
 */
function swiftRangeHeadType(head: string): TypeRef | undefined {
  if (!head.startsWith("(") || !head.endsWith(")")) return undefined;
  const inner = head.slice(1, -1);
  let depth = 0;
  let quote = false;
  let found: { readonly at: number; readonly name: string } | undefined;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      // The opening parenthesis closed before the end: `(a)…(b)` is no one group.
      if (--depth < 0) return undefined;
    } else if (depth === 0 && found === undefined && inner.startsWith("..", i)) {
      const op = inner.startsWith("..<", i) ? "..<" : inner.startsWith("...", i) ? "..." : undefined;
      if (op === undefined) return undefined;
      found = { at: i, name: op === "..<" ? "Range" : "ClosedRange" };
      i += op.length - 1;
    }
  }
  if (found === undefined || depth !== 0 || quote) return undefined;
  const lower = inner.slice(0, found.at).trim();
  const upper = inner.slice(found.at + 3).trim();
  return lower.length > 0 && upper.length > 0 ? { form: "instance", name: found.name } : undefined;
}

/** A fallback no `nil` can hide in: a collection, string, number or boolean literal. */
const SWIFT_NON_OPTIONAL_LITERAL = /^(?:\[[\s\S]*\]|"[\s\S]*"|-?\d[\w.]*|true|false)$/;

/** Postfix unwrap sugar on a link — `a?.b`, `a!.b`, a trailing `a?` — which the spelled fold does not read. */
const SWIFT_POSTFIX_UNWRAP = /(?<=[\w)\]])[?!](?=\.|$)/g;

/**
 * The type a parenthesised `??` head denotes (bd tea-rags-mcp-y99pg.39):
 * `(results ?? [])` is the left operand's WRAPPED type when the fallback is a
 * literal, which can never be `nil` — with an Optional fallback the value
 * would still be an Optional, and `Optional`'s members would answer instead.
 * The first `??` at the parentheses' own depth, outside any string, splits the
 * operands; `??` is right-associative, so a chained fallback is no literal and
 * types nothing. The left operand is folded by `ports` with its unwrap sugar
 * removed; the fold reads an Optional as what it wraps.
 */
function swiftNilCoalescingHeadType(
  head: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (!head.startsWith("(") || !head.endsWith(")")) return undefined;
  const inner = head.slice(1, -1);
  let depth = 0;
  let quote = false;
  let at = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return undefined;
    } else if (depth === 0 && at === -1 && inner.startsWith("??", i)) {
      at = i;
      i++;
    }
  }
  if (at === -1 || depth !== 0 || quote) return undefined;
  const lhs = inner.slice(0, at).trim().replace(SWIFT_POSTFIX_UNWRAP, "");
  const rhs = inner.slice(at + 2).trim();
  if (lhs.length === 0 || !SWIFT_NON_OPTIONAL_LITERAL.test(rhs)) return undefined;
  const type = propagateReceiverType(lhs, atLine, ctx, ports);
  return type === undefined ? undefined : swiftUnwrappedOptional(type);
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
    // `read(\.activeRequests)`: a key path binds a generic return (bd tea-rags-mcp-y99pg.37).
    memberCallTypeOf: (recv: TypeRef, member: string, argumentText: string, ctx: CallContext): TypeRef | undefined =>
      boundedBy(
        recv,
        swiftKeyPathCallType(recv, member, argumentText, ctx, members, ports) ??
          swiftMemberHopType(recv, member, ctx, members),
      ),
    maxHops: (): number => SWIFT_CHAIN_MAX_HOPS,
    // An argument list carries its own dots (`request(for: task.id)`).
    splitReceiverHops,
  });
  return ports;
}

/**
 * The fold over a receiver AS WRITTEN — `CallRef.writtenReceiver`, unwrap
 * sugar intact — in which `T?` is `Optional<T>` (bd tea-rags-mcp-y99pg.33).
 *
 * Every other fold reads text the walker normalized, where `a?.b` and `a.b`
 * are one string, so it has to read an optional as what it wraps. This one
 * reads the sugar: a link written straight on an optional value
 * (`response.map(…)`) is `Optional`'s member; behind `?` / `!` it is the
 * wrapped type's. A member `Optional` does not declare falls through to the
 * wrapped type either way — the index's belief that a value is optional is
 * only as good as the unwraps the walker saw. Optional-ness comes from a
 * binding or property DECLARED `T?` and from an SDK member's declared type;
 * a local bound by spelling is folded by the normalized ports, since its
 * spelling carries no sugar to read.
 */
export function createSwiftWrittenReceiverTypePorts(members: SwiftMemberTypeLookup): ReceiverTypePorts {
  const spelled = createSwiftReceiverTypePorts(members);
  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined => {
      const { text, unwraps } = swiftUnwrapSugar(receiver);
      const type = swiftHeadType(text, atLine, ctx, members, spelled, true);
      return unwraps ? swiftUnwrappedOptional(type) : type;
    },
    seedHead: (): undefined => undefined,
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined => {
      const { text, unwraps } = swiftUnwrapSugar(member);
      const type = boundedBy(recv, swiftWrittenMemberHopType(recv, text, ctx, members));
      return unwraps ? swiftUnwrappedOptional(type) : type;
    },
    maxHops: (): number => SWIFT_CHAIN_MAX_HOPS,
    splitReceiverHops: swiftWrittenReceiverHops,
  });
}

/**
 * The type of `call`'s receiver AS THE CALL'S MEMBER IS LOOKED UP ON IT (bd
 * tea-rags-mcp-y99pg.33): the written receiver folded through `writtenPorts`
 * ({@link createSwiftWrittenReceiverTypePorts}), then — for an `Optional` the
 * source did not unwrap — `Optional` itself where it declares the member,
 * else the wrapped type.
 */
export function swiftCallReceiverType(
  call: CallRef,
  ctx: CallContext,
  writtenPorts: ReceiverTypePorts,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const receiver = call.writtenReceiver ?? call.receiver;
  if (receiver === null) return undefined;
  const type = propagateReceiverType(receiver, call.startLine, ctx, writtenPorts);
  return type === undefined ? undefined : swiftOptionalMemberOwner(type, call.member, ctx, members);
}

/** What `member` written straight on a value of `type` is looked up on: see {@link swiftCallReceiverType}. */
function swiftOptionalMemberOwner(
  type: TypeRef,
  member: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  if (!isSwiftOptionalRef(type) || members.optionalDeclares(member, ctx)) return type;
  return swiftUnwrappedOptional(type);
}

/** One member hop in the written fold: `Optional`'s own member first, else the wrapped type's. */
function swiftWrittenMemberHopType(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): TypeRef | undefined {
  const owner = swiftOptionalMemberOwner(recv, stripCallArgs(member), ctx, members);
  return owner === undefined ? undefined : swiftMemberHopType(owner, member, ctx, members, true);
}

/** `Optional<T>` as the fold spells it. */
function swiftOptionalOf(wrapped: TypeRef): TypeRef {
  return { form: "instance", name: SWIFT_OPTIONAL, args: [wrapped] };
}

/** Whether `type` is an `Optional` value. */
function isSwiftOptionalRef(type: TypeRef): boolean {
  return type.form === "instance" && type.name === SWIFT_OPTIONAL;
}

/**
 * What unwrapping `type` yields: the wrapped type of an `Optional` (nothing,
 * when the fold never learned it), and any other type itself — a value the
 * index read as non-optional is already what an unwrap would give.
 */
function swiftUnwrappedOptional(type: TypeRef | undefined): TypeRef | undefined {
  if (type === undefined || !isSwiftOptionalRef(type) || (type.form !== "instance" && type.form !== "class")) {
    return type;
  }
  const wrapped = type.args?.[0];
  return wrapped === undefined ? undefined : boundedBy(type, wrapped);
}

/** A written head or link with its trailing `?` / `!` split off. */
function swiftUnwrapSugar(text: string): { readonly text: string; readonly unwraps: boolean } {
  const trimmed = text.trim();
  const marker = /[?!]+$/.exec(trimmed);
  return marker === null ? { text, unwraps: false } : { text: trimmed.slice(0, marker.index), unwraps: true };
}

/**
 * The hop split for a WRITTEN receiver: the depth-aware split every Swift fold
 * uses, with each link's trailing `?` / `!` moved ahead of its argument list
 * (`c(x)?` → `c?(x)`) — the kernel strips a link's arguments before the port
 * sees it, and the unwrap must survive that. The head keeps its sugar where it
 * stands: the port reads a head whole.
 */
function swiftWrittenReceiverHops(receiver: string): string[] {
  return splitReceiverHops(receiver).map((segment, i) => {
    if (i === 0) return segment;
    const trimmed = segment.trim();
    const marker = /[?!]+$/.exec(trimmed);
    if (marker === null) return segment;
    const base = trimmed.slice(0, marker.index);
    const open = base.search(/[({]/);
    return open <= 0 ? trimmed : `${base.slice(0, open)}${marker[0]}${base.slice(open)}`;
  });
}

/** The standard library's `Optional`, which a declared `T?` is (bd tea-rags-mcp-y99pg.33). */
const SWIFT_OPTIONAL = "Optional";

/** `\.p`, `\.p.q`, `\.self` — the key paths {@link swiftKeyPathCallType} reads. */
const SWIFT_KEY_PATH_ARGUMENT = /^\\\.(self|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;

/**
 * What `recv.member(\.p)` returns when `member` returns its closure's result
 * (bd tea-rags-mcp-y99pg.37): `read<U>(_ closure: (Value) throws -> U) -> U`
 * given the key path `\.p` — a function from the closure's parameter to its
 * `p` (SE-0249) — returns the type of `p` on that parameter. The parameter is
 * a concrete type as declared, or one of the declaring type's generic
 * parameters bound by the receiver's arguments. Each key-path component is a
 * member hop; `\.self` is the parameter itself. Undefined for any other
 * argument, or when a hop is unknown.
 */
function swiftKeyPathCallType(
  recv: TypeRef,
  member: string,
  argumentText: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  const keyPath = SWIFT_KEY_PATH_ARGUMENT.exec(argumentText.trim());
  if (keyPath === null || (recv.form !== "instance" && recv.form !== "class")) return undefined;
  const signature = members.closureParameterTypes(recv.name, member, ctx);
  if (signature === undefined || !signature.returnsClosureResult || signature.types?.length !== 1) return undefined;
  const declared = signature.types[0];
  if (declared === null) return undefined;
  const slot = signature.genericParameters.indexOf(declared);
  let root: TypeRef | undefined = slot === -1 ? swiftDeclaredTypeRef(declared) : recv.args?.[slot];
  if (keyPath[1] === "self") return root;
  for (const component of keyPath[1].split(".")) {
    if (root === undefined) return undefined;
    root = ports.memberTypeOf(root, component, ctx);
  }
  return root;
}

/** `owner.member` as a type the project DECLARES (not merely re-opens), in type form. */
function swiftNestedProjectType(owner: string, member: string, ctx: CallContext): TypeRef | undefined {
  if (!isSwiftTypeName(member)) return undefined;
  const qualified = `${owner}.${member}`;
  const declaring = swiftDeclaringFiles(qualified, ctx);
  return declaring !== undefined && declaring.size > 0 ? { form: "class", name: qualified } : undefined;
}

/** The type one member hop off `recv` denotes — the fold's `memberTypeOf`, before the bound mark. */
function swiftMemberHopType(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
  keepsOptionals = false,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  // `self.$result` / `model.$result`: the property's wrapper, projected (bd tea-rags-mcp-y99pg.33).
  const projected = SWIFT_PROJECTED_VALUE.exec(member.trim());
  if (projected !== null) return swiftProjectedValueType(recv, projected[1], ctx, members);
  // `CodeUsage.Tile`: a type path off a type names the NESTED type the
  // project declares — Swift forbids a member of the same name beside it, so
  // this reading excludes every other (bd tea-rags-mcp-y99pg.39).
  const nested = recv.form === "class" ? swiftNestedProjectType(recv.name, member, ctx) : undefined;
  if (nested !== undefined) return nested;
  // The field channel records no staticness, so the receiver's form does
  // not select a channel here — a `class` head and an `instance` head read
  // the same property map. Accessing a property always yields a VALUE, so
  // the hop's own form is `instance` either way.
  const fieldType = members.typeOfProperty(recv.name, member, ctx);
  if (fieldType !== undefined) {
    const field = swiftTypeRefWithArguments(fieldType, members.fieldTypeArguments(recv.name, member, ctx));
    // `completion.error` on an `error: AFError?` (bd tea-rags-mcp-y99pg.33).
    return keepsOptionals && members.isOptionalProperty(recv.name, member, ctx) ? swiftOptionalOf(field) : field;
  }
  // A property typed as a generic parameter: the receiver's argument for it (bd tea-rags-mcp-y99pg.34).
  const generic = members.genericFieldType(recv, member, ctx);
  if (generic !== undefined) return generic;
  // Not a property: a METHOD hop, typed by what the declaration the call
  // lands on returns. Strict: an ambiguous callee types nothing.
  const returned = members.memberReturnType(recv.name, member, ctx);
  if (returned) return returned;
  // A member the project declares on none of the receiver's types: the
  // SDK's declaration, substituted for the receiver (bd tea-rags-mcp-y99pg.25).
  const declared = keepsOptionals
    ? members.sdkMemberTypeKeepingOptionals(recv, member, ctx)
    : members.sdkMemberType(recv, member, ctx);
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
  keepsOptionals = false,
): TypeRef | undefined {
  const typed = resolveLocalBinding(ctx.localBindings, name, atLine);
  // A binding declared `T?` IS an `Optional` of T, for the reader that knows
  // where the source unwraps it (bd tea-rags-mcp-y99pg.33).
  const typedRef = (binding: NonNullable<typeof typed>): TypeRef =>
    keepsOptionals && binding.typeRef !== undefined && isSwiftOptionalRef(binding.typeRef)
      ? binding.typeRef
      : { form: "instance", name: binding.type };
  let spelled: CallResultBinding | undefined;
  for (const binding of identifierEntry(ctx.callResultBindings, name) ?? []) {
    if (!swiftBindingVisible(binding, name, atLine)) continue;
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < atLine) continue;
    if (spelled === undefined || binding.line > spelled.line) spelled = binding;
  }
  if (spelled === undefined || (typed !== undefined && typed.line >= spelled.line)) {
    return typed === undefined ? undefined : typedRef(typed);
  }
  if (spelled.closureParameter !== undefined) {
    return swiftClosureParameterType(spelled.callee, spelled.closureParameter, spelled.line, ctx, ports, members);
  }
  if (swiftSpellingHidesOptionalMember(spelled.callee, spelled.line, ctx, members)) return undefined;
  const folded = propagateReceiverType(spelled.callee, spelled.line, ctx, ports);
  if (folded?.form !== "instance") return undefined;
  // `for request in requests`: the loop draws the sequence's element (bd tea-rags-mcp-y99pg.37).
  if (spelled.sequenceElement === true) return members.sdkSequenceElementType(folded);
  // `case .group(let g)`: the subject's enum says what the slot carries (bd tea-rags-mcp-y99pg.16).
  // The cases are published under the enum's QUALIFIED id, and a `self`
  // subject folds to the enclosing type's short name — `switch self` inside
  // `URLEncodedFormEncoder.DateEncoding` (bd tea-rags-mcp-y99pg.31).
  if (spelled.enumPayload !== undefined) {
    const enumId = qualifySwiftTypeName(folded.name, ctx);
    const payload = swiftEnumCasePayloadType(enumId, spelled.enumPayload.caseName, spelled.enumPayload.index, ctx);
    return payload === undefined ? undefined : { form: "instance", name: payload };
  }
  return folded;
}

/** The written-fold probe {@link swiftSpellingHidesOptionalMember} runs, built once per member lookup. */
interface SwiftSpellingOptionalProbe {
  readonly ports: ReceiverTypePorts;
  readonly state: { ambiguous: boolean };
}

const SWIFT_SPELLING_OPTIONAL_PROBES = new WeakMap<SwiftMemberTypeLookup, SwiftSpellingOptionalProbe>();

/**
 * Whether folding `callee` — a SPELLING, unwrap sugar stripped — steps onto a
 * member `Optional` itself declares while the value it steps from is an
 * `Optional` (bd tea-rags-mcp-y99pg.39). `shortName.flatMap { … }` on a
 * `String?` is `Optional.flatMap` as written and `String.flatMap` behind a
 * `?`, and the spelling is the same string for both: the two readings return
 * different types, so the local is left untyped rather than typed by a guess.
 *
 * The probe is the written fold (which reads a sugar-free link as written
 * straight on the value) with its member hop instrumented. A nested fold can
 * re-enter through a head bound to another spelling, so the flag is saved and
 * restored around each probe.
 */
function swiftSpellingHidesOptionalMember(
  callee: string,
  line: number,
  ctx: CallContext,
  members: SwiftMemberTypeLookup,
): boolean {
  let probe = SWIFT_SPELLING_OPTIONAL_PROBES.get(members);
  if (probe === undefined) {
    const written = createSwiftWrittenReceiverTypePorts(members);
    const state = { ambiguous: false };
    const ports: ReceiverTypePorts = Object.freeze({
      ...written,
      memberTypeOf: (recv: TypeRef, member: string, at: CallContext): TypeRef | undefined => {
        if (isSwiftOptionalRef(recv) && members.optionalDeclares(stripCallArgs(member), at)) state.ambiguous = true;
        return written.memberTypeOf(recv, member, at);
      },
    });
    probe = { ports, state };
    SWIFT_SPELLING_OPTIONAL_PROBES.set(members, probe);
  }
  const saved = probe.state.ambiguous;
  probe.state.ambiguous = false;
  propagateReceiverType(callee, line, ctx, probe.ports);
  const { ambiguous } = probe.state;
  probe.state.ambiguous = saved;
  return ambiguous;
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
  if (slot === -1) return boundedBy(type, swiftDeclaredTypeRef(declared));
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
      return swiftDeclaredTypeRef(declared);
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
    return swiftDeclaredTypeRef(declared);
  }
  return members.sdkClosureParameterType(type, "init", index, ctx);
}

/**
 * A published closure-parameter type as a value of it: `Result<URLRequest,
 * Error>` → `Result` of `URLRequest` and `Error`, so an SDK member read off it
 * substitutes the declaring type's parameters (bd tea-rags-mcp-y99pg.32). The
 * walker spells arguments only when every one is a plain nominal; anything
 * else parses to the bare nominal the text starts with.
 */
function swiftDeclaredTypeRef(declared: string): TypeRef {
  const parsed = parseSwiftTypeText(declared);
  if (parsed?.kind !== "nominal") return { form: "instance", name: declared.replace(/<[\s\S]*$/, "") };
  const args = parsed.args.map((arg) => (arg.kind === "nominal" && arg.args.length === 0 ? arg.path : null));
  return swiftTypeRefWithArguments(parsed.path, args);
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
