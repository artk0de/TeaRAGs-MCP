/**
 * Overload selection by ARGUMENT TYPE (bd tea-rags-mcp-82l7s).
 *
 * Swift overloads by parameter type as well as by label: `Color(hex: UInt32)`
 * and `Color(hex: String)` share the label, so label narrowing
 * (`narrowSwiftOverloads`) keeps both, and a construction whose two
 * initializers live in different files could not be placed. The walker now
 * publishes each labelled parameter's nominal type (`KwargSignature.types`);
 * this module reads the call's labelled arguments, types what it can prove,
 * and REJECTS a declaration whose declared type the argument cannot bind to.
 *
 * Precision is the whole design. Without a type checker, "cannot bind" is
 * provable only between CLOSED value types — SDK structs and enums the project
 * does not declare itself: neither side has subtypes, so a `UInt32` never
 * passes where a `String` is declared. Against anything else — a class, a
 * protocol, a project type, a typealias the substrate does not know, a
 * generic parameter — an argument may still bind (a subclass, a conformance,
 * an alias), so the declaration is kept. A literal proves less still: it binds
 * to any type expressible by its kind, so it rejects only the closed value
 * types that kind can never spell (a string literal is never a `UInt32`). The
 * one implicit conversion Swift performs between value types, `Double` ⇄
 * `CGFloat`, rejects nothing. An argument it cannot type — or types only by a
 * bound, or as an `Optional` — is no evidence, and a declaration that
 * records no type for the label keeps itself: missing evidence never drops.
 */

import type { CallContext, CallRef, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  callArgumentText,
  propagateReceiverType,
  splitAtBracketDepthZero,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import type { SwiftSdkVocabulary } from "../vocabulary/sdk-vocabulary.js";
import { swiftDeclaringFiles } from "./swift-type-declarations.js";

/** What an argument is proven to be: a literal of some kind, or a value of a nominal type. */
type SwiftArgumentEvidence =
  | { readonly literal: "string" | "integer" | "float" | "boolean" }
  | { readonly nominal: string };

const SWIFT_ARGUMENT_LABEL = /^\s*([A-Za-z_]\w*)\s*:(?!:)\s*([\s\S]+?)\s*$/;
const SWIFT_STRING_LITERAL = /^(#*)"[\s\S]*"\1$/;
const SWIFT_INTEGER_LITERAL = /^-?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*)$/;
const SWIFT_FLOAT_LITERAL = /^-?\d[\d_]*(?:\.\d[\d_]*(?:[eE][+-]?\d+)?|[eE][+-]?\d+)$/;

const SWIFT_INTEGER_TYPES = [
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
] as const;
const SWIFT_FLOATING_TYPES = ["Double", "Float", "Float80", "CGFloat"] as const;
const SWIFT_TEXT_TYPES = ["String", "Substring", "Character"] as const;

/**
 * The closed value types a literal of each kind can never spell. A literal
 * binds to ANY type conforming to its `ExpressibleBy…Literal` protocol, so
 * only a type known not to conform is rejected — never a project type, which
 * may conform.
 */
const SWIFT_LITERAL_NEVER_SPELLS: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set([...SWIFT_INTEGER_TYPES, ...SWIFT_FLOATING_TYPES, "Bool"]),
  integer: new Set([...SWIFT_TEXT_TYPES, "Bool"]),
  float: new Set([...SWIFT_INTEGER_TYPES, ...SWIFT_TEXT_TYPES, "Bool"]),
  boolean: new Set([...SWIFT_INTEGER_TYPES, ...SWIFT_FLOATING_TYPES, ...SWIFT_TEXT_TYPES]),
};

/** Value types Swift converts between implicitly (SE-0307). */
const SWIFT_IMPLICIT_CONVERSIONS: ReadonlySet<string> = new Set(["Double|CGFloat", "CGFloat|Double"]);

/**
 * `defs` minus every declaration one of `call`'s labelled arguments PROVES it
 * cannot bind to. `ports` fold an argument expression to its type — the
 * resolver's own receiver fold, so an argument is typed exactly as a receiver
 * of the same spelling would be.
 */
export function narrowSwiftOverloadsByArgumentType(
  call: CallRef,
  defs: readonly SymbolDefinition[],
  ctx: CallContext,
  ports: ReceiverTypePorts,
  sdk: SwiftSdkVocabulary,
): SymbolDefinition[] {
  if (!defs.some((def) => def.kwargs?.types !== undefined)) return [...defs];
  const args = swiftLabelledArguments(call.callText);
  if (args.size === 0) return [...defs];
  const evidence = new Map<string, SwiftArgumentEvidence>();
  for (const [label, expression] of args) {
    const proven = swiftArgumentEvidence(expression, call.startLine, ctx, ports);
    if (proven !== undefined) evidence.set(label, proven);
  }
  if (evidence.size === 0) return [...defs];
  return defs.filter((def) => {
    const types = def.kwargs?.types;
    if (types === undefined) return true;
    for (const [label, proven] of evidence) {
      const declared = types[label];
      if (declared !== undefined && swiftArgumentCannotBind(proven, declared, ctx, sdk)) return false;
    }
    return true;
  });
}

/** The call's LABELLED arguments, label → expression text; a repeated label is dropped. */
function swiftLabelledArguments(callText: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = callArgumentText(callText);
  if (inner === undefined || inner.trim() === "") return out;
  const repeated = new Set<string>();
  for (const part of splitAtBracketDepthZero(inner, ",")) {
    const match = SWIFT_ARGUMENT_LABEL.exec(part);
    if (!match) continue;
    if (out.has(match[1])) repeated.add(match[1]);
    out.set(match[1], match[2]);
  }
  for (const label of repeated) out.delete(label);
  return out;
}

function swiftArgumentEvidence(
  expression: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): SwiftArgumentEvidence | undefined {
  if (SWIFT_STRING_LITERAL.test(expression)) return { literal: "string" };
  if (SWIFT_INTEGER_LITERAL.test(expression)) return { literal: "integer" };
  if (SWIFT_FLOAT_LITERAL.test(expression)) return { literal: "float" };
  if (expression === "true" || expression === "false") return { literal: "boolean" };
  const type: TypeRef | undefined = propagateReceiverType(expression, atLine, ctx, ports);
  if (type?.form !== "instance" || type.upperBound === true || type.name === "Optional") return undefined;
  return { nominal: type.name };
}

function swiftArgumentCannotBind(
  proven: SwiftArgumentEvidence,
  declaredText: string,
  ctx: CallContext,
  sdk: SwiftSdkVocabulary,
): boolean {
  // An optional parameter takes the wrapped type's values too.
  const declared = declaredText.endsWith("?") ? declaredText.slice(0, -1) : declaredText;
  if (!isClosedSwiftValueType(declared, ctx, sdk)) return false;
  if ("literal" in proven) return SWIFT_LITERAL_NEVER_SPELLS[proven.literal].has(declared);
  if (proven.nominal === declared || SWIFT_IMPLICIT_CONVERSIONS.has(`${proven.nominal}|${declared}`)) return false;
  return isClosedSwiftValueType(proven.nominal, ctx, sdk);
}

/**
 * An SDK struct or enum the project does not declare a namesake of — a value
 * type with no subtypes, whose identity no project code can widen. Requires
 * the run's `typeDeclarations` channel: without it a project namesake could
 * not be ruled out.
 */
function isClosedSwiftValueType(name: string, ctx: CallContext, sdk: SwiftSdkVocabulary): boolean {
  if (ctx.typeDeclarations === undefined) return false;
  const kind = sdk.type(name)?.kind;
  if (kind !== "struct" && kind !== "enum") return false;
  const declaring = swiftDeclaringFiles(name, ctx);
  return declaring === undefined || declaring.size === 0;
}
