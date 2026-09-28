/**
 * CALL collection: the `CallRef` channel (`collectSwiftCalls`), the call-site
 * shape the identifier-declaration pass re-reads (`swiftCallSiteShape`),
 * receiver normalization (`normalizeSwiftReceiver`), the local-value /
 * parameter tests that keep a value from masquerading as a callee, and the
 * argument-label signature a chunk publishes (`swiftCallableSignature`).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { AritySignature, CallRef, KwargSignature } from "../../../../contracts/types/codegraph.js";
import {
  parenthesizedSwiftTypeNode,
  singleIdentifierPatternName,
  SWIFT_FUNCTION_LIKE_NODES,
  swiftFunctionTypeNode,
  swiftLambdaParameters,
  swiftParameterTypeNode,
  walk,
} from "./shared.js";
import { swiftConstructedGenericFact, swiftGenericConstraint } from "./type-evidence.js";

/**
 * One `CallRef` per invoking `call_expression`. Two callee shapes carry a call:
 * a bare `simple_identifier` (receiverless) and a `navigation_expression`
 * (`target` = receiver, `suffix.suffix` = member). Every other shape — an
 * immediately-invoked closure, a call on a parenthesised expression — names no
 * receiver this resolver could use and is skipped rather than guessed.
 *
 * `Foo()` is recorded as a BARE call whose member is `Foo`, not as
 * `Foo#init`. Swift's `Foo()` is sugar for `Foo.init(…)`, but a type relying on
 * the memberwise or default initializer declares no `init_declaration` and so
 * has no `Foo#init` symbol to land on; the bare form still resolves to the TYPE
 * through the terminal short-name pass, which is the edge that exists.
 */
export function collectSwiftCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    const shape = swiftCallSiteShape(node);
    if (shape === null) return;
    // The argument list: a construction's `constructor_suffix`, a call's `call_suffix`.
    const suffix = node.children.find((c) => c.type === "constructor_suffix" || c.type === "call_suffix");
    out.push({
      callText: node.text,
      receiver: shape.receiver,
      ...(shape.writtenReceiver === undefined ? {} : { writtenReceiver: shape.writtenReceiver }),
      member: shape.member,
      startLine: node.startPosition.row + 1,
      ...(suffix ? swiftCallArguments(suffix) : {}),
    });
  });
  return out;
}

/** The `{ receiver, member }` pair a Swift `CallRef` carries. */
export interface SwiftCallShape {
  receiver: string | null;
  /** The receiver as written when it differs from `receiver` (`a?` for `a?.c()`). */
  writtenReceiver?: string;
  member: string;
}

/**
 * The `{ receiver, member }` of the `CallRef` {@link collectSwiftCalls} emits
 * for `node`, or null when it emits none. Read by the identifier-declaration
 * pass so a declaration's bound callee matches that `CallRef` by construction
 * (bd tea-rags-mcp-4p3sb.16).
 *
 * `Protected<[T]>(…)` is a construction the grammar does not call a call: a
 * bare call named by the constructed nominal, when it is undotted. A bracketed
 * suffix is a subscript read (`items[i]`, `dict["k"]`), not a call. Invoking a
 * closure VALUE calls no declared symbol (bd tea-rags-mcp-y99pg.8).
 */
export function swiftCallSiteShape(node: AstNode): SwiftCallShape | null {
  if (node.type === "constructor_expression") {
    const name = swiftConstructedGenericFact(node).nominal;
    return name && !name.includes(".") ? { receiver: null, member: name } : null;
  }
  if (node.type !== "call_expression") return null;
  const suffix = node.children.find((c) => c.type === "call_suffix");
  if (!suffix || suffix.text.startsWith("[")) return null;
  const callee = node.namedChildren.find((c) => c !== suffix);
  if (callee?.type === "simple_identifier") {
    if (node.children.some((c) => c.type === "?") || isSwiftLocalValueName(callee.text, node)) return null;
    return { receiver: null, member: callee.text };
  }
  if (callee?.type !== "navigation_expression") return null;
  const target = callee.childForFieldName("target");
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
  if (!target || !member) return null;
  const targetText = swiftReceiverTargetText(target);
  const receiver = normalizeSwiftReceiver(targetText);
  // `a?.c()` puts its `?` beside the target, not inside it (bd tea-rags-mcp-y99pg.33).
  const written = callee.children.some((c) => c.type === "?") ? `${targetText}?` : targetText;
  return { receiver, ...(written === receiver ? {} : { writtenReceiver: written }), member: member.text };
}

/**
 * Whether `name`, at `at`, names a VALUE the enclosing code declares — a
 * parameter of an enclosing function or closure, or a `let` / `var` an
 * enclosing block declares ABOVE `at` — rather than a function. Swift resolves
 * a bare name to the innermost declaration, so such a `name(...)` invokes the
 * value and calls no declared symbol. The walk stops at the enclosing type: a
 * stored property of closure type is indistinguishable from a method by name
 * here, and only the optional-call form (`name?(…)`) says which it is.
 */
function isSwiftLocalValueName(name: string, at: AstNode): boolean {
  const line = at.startPosition.row;
  for (let current = at.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") return false;
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type) && declaresSwiftParameter(current, name)) return true;
    if (current.type === "lambda_literal") {
      const params = swiftLambdaParameters(current) ?? [];
      if (params.some((p) => p.childForFieldName("name")?.text === name)) return true;
    }
    if (current.type === "statements") {
      for (const statement of current.children) {
        if (statement.startPosition.row >= line) break;
        if (
          statement.type === "property_declaration" &&
          singleIdentifierPatternName(statement.childForFieldName("name")) === name
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Whether a function-like declaration takes a parameter whose INTERNAL name is `name`. */
function declaresSwiftParameter(fn: AstNode, name: string): boolean {
  return fn.children.some((parameter) => {
    if (parameter.type !== "parameter") return false;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children.slice(0, colon === -1 ? undefined : colon);
    const internal = names.filter((c) => c.type === "simple_identifier").pop();
    return internal?.text === name;
  });
}

/**
 * A call target's text without the prefix operator the grammar hangs on it
 * (bd tea-rags-mcp-y99pg.39). tree-sitter-swift parses `!kept.contains(id)`
 * with `!kept` as the navigation target, but Swift binds a prefix operator
 * looser than member access and call: the expression is `!(kept.contains(id))`
 * and the receiver is `kept`. The operator sits on the leftmost spine of the
 * target, however deep (`!a!.b.c()`). An implicit member expression's leading
 * `.` (`.quaternary.opacity(1)`) is part of the receiver and stays.
 *
 * The same grammar folds an additive or multiplicative expression into the
 * target — `PixelCanvas.width - font.width(x)` navigates off
 * `PixelCanvas.width - font` — where Swift binds the call to the RIGHT
 * operand alone: the receiver is `font`. Any infix shape found as a target is
 * such a misbinding (a parenthesised one is a tuple), so the walk takes the
 * right operand of each, then strips a prefix operator off what is left.
 */
function swiftReceiverTargetText(target: AstNode): string {
  const operand = swiftReceiverOperand(target);
  return withoutSwiftComments(target, operand.startIndex);
}

/** Comment node types tree-sitter-swift emits. */
const SWIFT_COMMENT_NODES: ReadonlySet<string> = new Set(["comment", "multiline_comment"]);

/**
 * `node`'s source text from `from` on, every comment inside it dropped (bd
 * tea-rags-mcp-2rf51). A SwiftUI modifier chain interleaves comments with its
 * links, and a comment's own `.` would otherwise split the receiver into hops
 * no fold can type. A comment is trivia, so what remains is the expression.
 */
function withoutSwiftComments(node: AstNode, from: number): string {
  const comments: AstNode[] = [];
  walk(node, (n) => {
    if (SWIFT_COMMENT_NODES.has(n.type) && n.startIndex >= from) comments.push(n);
  });
  const { text } = node;
  if (comments.length === 0) return text.slice(from - node.startIndex);
  comments.sort((a, b) => a.startIndex - b.startIndex);
  let out = "";
  let at = from;
  for (const comment of comments) {
    if (comment.startIndex < at) continue;
    out += text.slice(at - node.startIndex, comment.startIndex - node.startIndex);
    at = comment.endIndex;
  }
  return out + text.slice(at - node.startIndex);
}

/** The node a call's receiver really is, inside the target the grammar handed over — see {@link swiftReceiverTargetText}. */
function swiftReceiverOperand(target: AstNode): AstNode {
  // An infix shape keeps its right operand under one of these: `a - b`,
  // `a...b`, `a ?? b`, `c ? a : b`.
  const rights = [
    target.childForFieldName("rhs"),
    target.childForFieldName("end"),
    target.childForFieldName("if_nil"),
    target.childForFieldName("if_false"),
  ];
  for (const right of rights) {
    if (right !== null && right.endIndex === target.endIndex) return swiftReceiverOperand(right);
  }
  let node: AstNode | null = target;
  while (node !== null && node.startIndex === target.startIndex) {
    if (node.type === "prefix_expression") {
      const operation = node.childForFieldName("operation");
      const operand = node.childForFieldName("target");
      if (operation !== null && operand !== null && operation.text !== ".") return swiftReceiverOperand(operand);
    }
    node = node.child(0);
  }
  return target;
}

/**
 * Strip optional-chaining `?` and force-unwrap `!` out of a receiver's source
 * text: `obj!` → `obj`, `a?.b!` → `a.b`, `self.db` unchanged. The resolver
 * matches a receiver against `localBindings` keys and `classFieldTypes` field
 * names, neither of which carries the sugar, so an un-normalized receiver never
 * matches.
 */
export function normalizeSwiftReceiver(text: string): string {
  return text.replace(/[?!]/g, "");
}

/** A callable's argument-label signature, in the shape `SymbolDefinition` persists. */
export interface SwiftCallableSignature {
  readonly arity: AritySignature;
  readonly kwargs: KwargSignature;
  readonly acceptsBlock: boolean;
}

/**
 * The argument-label signature of a `func` / `init` (bd tea-rags-mcp-y99pg.7),
 * mapped onto the kernel's call-compatibility axes: a LABELLED parameter is a
 * keyword (`kwargs`), an unlabelled (`_`) one a positional slot (`arity`), and
 * whether a trailing closure can land on it (`acceptsBlock`).
 *
 * Whether a parameter can take a closure is three-valued
 * ({@link swiftClosureCapability}), because a closure type is very often
 * spelled through a typealias (`closure: @escaping ProgressHandler`,
 * `_ closure: QuickConfigurer`) that no file-local read can expand. A PROVEN
 * closure parameter is never required on either axis — a trailing closure may
 * satisfy it without its label or its position — and neither is a defaulted
 * or variadic one. A POSSIBLE one stays required, and the resolver lets a
 * trailing closure stand in for one missing requirement. `acceptsBlock` is
 * false only when no parameter can take a closure. A single parameter name is
 * both label and local name, which is Swift's rule for every declaration here.
 */
export function swiftCallableSignature(fn: AstNode): SwiftCallableSignature {
  const required: string[] = [];
  const optional: string[] = [];
  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  let acceptsBlock = false;
  const types: Record<string, string> = {};
  const repeatedLabels = new Set<string>();
  fn.children.forEach((parameter, i) => {
    if (parameter.type !== "parameter") return;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children
      .slice(0, colon === -1 ? undefined : colon)
      .filter((c) => c.type === "simple_identifier")
      .map((c) => c.text);
    const label = names[0] === "_" ? null : (names[0] ?? null);
    const capability = swiftClosureCapability(parameter, fn);
    const variadic = parameter.children.some((c) => c.type === "...");
    const defaulted = fn.children[i + 1]?.type === "=";
    const mandatory = capability !== "yes" && !variadic && !defaulted;
    if (capability !== "no") acceptsBlock = true;
    if (label !== null) {
      if (required.includes(label) || optional.includes(label)) repeatedLabels.add(label);
      (mandatory ? required : optional).push(label);
      const nominal = swiftNominalParameterType(parameter);
      if (nominal !== undefined) types[label] = nominal;
      return;
    }
    maxPositional += 1;
    if (variadic) hasSplat = true;
    if (mandatory) minRequired += 1;
  });
  // A label two parameters share says nothing about WHICH one an argument binds.
  for (const label of repeatedLabels) delete types[label];
  return {
    arity: { minRequired, maxPositional, hasSplat },
    kwargs: { required, optional, hasSplat: false, ...(Object.keys(types).length > 0 ? { types } : {}) },
    acceptsBlock,
  };
}

/**
 * A parameter's declared type when it is a plain NOMINAL — `UInt32`,
 * `Tag.Kind`, or one of those made optional (`Double?`) — spelled as written,
 * whitespace dropped (bd tea-rags-mcp-82l7s). A function, tuple, collection,
 * generic-argument or metatype spelling answers `undefined`: the resolver
 * compares an argument's proven type against a NAME, and only a name can be
 * compared without a type checker.
 */
function swiftNominalParameterType(parameter: AstNode): string | undefined {
  const typeNode = swiftParameterTypeNode(parameter);
  if (!typeNode) return undefined;
  const inner = typeNode.type === "optional_type" ? typeNode.namedChildren[0] : typeNode;
  if (inner?.type !== "user_type") return undefined;
  const name = inner.text.replace(/\s+/g, "");
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name) || name.endsWith(".Type")) return undefined;
  return typeNode === inner ? name : `${name}?`;
}

/** Value types a closure is never spelled as — the common non-closure parameter types. */
const SWIFT_NON_CLOSURE_TYPES: ReadonlySet<string> = new Set([
  "String",
  "Substring",
  "Character",
  "Int",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "UInt",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "Double",
  "Float",
  "CGFloat",
  "Bool",
  "Data",
  "Date",
  "URL",
  "UUID",
  "TimeInterval",
  "DispatchQueue",
  "OperationQueue",
]);

/**
 * Whether a parameter can take a closure: `yes` for a function type or an
 * `@escaping` / `@Sendable` one (only a closure carries those), `no` for an
 * `@autoclosure` one and for a type that is provably not a function — an array,
 * dictionary, real tuple or metatype, a protocol-constrained generic
 * parameter (a function type conforms to no protocol), or a common value
 * type — and `maybe` for any other name, which may be a closure typealias.
 */
function swiftClosureCapability(parameter: AstNode, fn: AstNode): "yes" | "no" | "maybe" {
  const modifiers = parameter.children.filter((c) => c.type === "type_modifiers" || c.type === "parameter_modifiers");
  // `@autoclosure` wraps the argument EXPRESSION; a closure literal written
  // there is the value itself, so no trailing closure lands on it — checked
  // first, since its spelled type IS a function type (bd tea-rags-mcp-y99pg.36).
  if (modifiers.some((c) => /@autoclosure\b/.test(c.text))) return "no";
  const typeNode = swiftParameterTypeNode(parameter);
  if (swiftFunctionTypeNode(typeNode) !== null) return "yes";
  const attributed = modifiers.some((c) => /@(escaping|Sendable)\b/.test(c.text));
  if (attributed) return "yes";
  let bare = typeNode;
  while (bare?.type === "optional_type") bare = bare.namedChildren[0] ?? null;
  if (!bare) return "maybe";
  if (bare.type === "array_type" || bare.type === "dictionary_type" || bare.type === "metatype") return "no";
  if (bare.type === "tuple_type" && parenthesizedSwiftTypeNode(bare) === null) return "no";
  if (bare.type !== "user_type") return "maybe";
  const name = bare.text.replace(/<[\s\S]*$/, "");
  if (name.endsWith(".Type") || SWIFT_NON_CLOSURE_TYPES.has(name)) return "no";
  const constraint = swiftGenericConstraint(name, fn);
  return constraint !== undefined && constraint !== null ? "no" : "maybe";
}

/**
 * What a call writes, on the same axes: its labels, its unlabelled argument
 * count and whether a trailing closure follows the parentheses.
 */
function swiftCallArguments(suffix: AstNode): Pick<CallRef, "argCount" | "kwargKeys" | "passesBlock"> {
  const args = suffix.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const kwargKeys: string[] = [];
  let argCount = 0;
  for (const arg of args) {
    if (arg.type !== "value_argument") continue;
    const label = arg.children.find((c) => c.type === "value_argument_label")?.text;
    if (label === undefined) argCount += 1;
    else kwargKeys.push(label);
  }
  return { argCount, kwargKeys, passesBlock: suffix.children.some((c) => c.type === "lambda_literal") };
}

/** The last closure literal a call passes — parenthesized or trailing — or undefined. */
export function lastClosureArgument(suffix: AstNode): AstNode | undefined {
  let last: AstNode | undefined;
  for (const child of suffix.children) {
    if (child.type === "lambda_literal") last = child;
    else if (child.type === "value_arguments") {
      for (const argument of child.namedChildren) {
        const value = argument.type === "value_argument" ? argument.namedChildren.at(-1) : undefined;
        if (value?.type === "lambda_literal") last = value;
      }
    }
  }
  return last;
}

/**
 * A construction written as a closure's receiver — `Result { try … }` in
 * `Result { try … }.mapError { $0 … }` — spelled WHOLE, arguments and all,
 * since the resolver types a construction head by the type it names and the
 * generic arguments it spells (bd tea-rags-mcp-y99pg.31). Only an
 * UpperCamelCase callee is a construction; `make(1).then { … }` is a call
 * whose value no spelling here can carry.
 */
export function swiftConstructionSpelling(node: AstNode | null): string | undefined {
  if (node?.type !== "call_expression") return undefined;
  const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" || !/^_*[A-Z]/.test(callee.text)) return undefined;
  return node.text;
}
