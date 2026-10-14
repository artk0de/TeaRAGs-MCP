/**
 * ECMAScript type member census (bd tea-rags-mcp-ffxfc) — how many of the
 * members a class body, interface body or object type writes are BEHAVIOUR and
 * how many are DATA, for `FileExtraction.typeMemberCensus`. The type-declaration
 * pass calls it on each declaration it records, so it adds no traversal.
 *
 *   | member                                                       | counts as |
 *   | ------------------------------------------------------------ | --------- |
 *   | method, overload / abstract signature, method signature      | method    |
 *   | call signature, construct signature                          | method    |
 *   | property or field whose type or value is a function          | method    |
 *   | `get x` / `set x` (a pair is ONE member)                     | field     |
 *   | any other property or field, `accessor x`                    | field     |
 *   | constructor parameter property (`private readonly s: S`)     | field     |
 *   | the constructor itself, an index signature, a static block   | —         |
 *
 * An accessor is data: it reads and writes a value, however it computes it, and
 * a caller spells it as a property. The constructor builds the value rather than
 * being a member of it. Counts are of distinct member NAMES, so overloads and an
 * accessor pair count once; a name read both ways keeps its first reading.
 *
 * A CLASS census also counts its ASYNC instance methods (bd tea-rags-mcp-ek2cu):
 * a non-static method, method signature or abstract signature — any visibility,
 * the constructor and accessors excluded — written `async` or returning a
 * `Promise` / `PromiseLike` head. An operations facade's methods are async, a
 * computational model's are not, and nothing else in the census separates them.
 * An interface or object type has no such count: unknown, never zero.
 *
 * Naming data only — the `cg_symbols` rows (and their `symbolKind`) the resolver
 * reads are the symbol-kind pass's and are not touched here.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import { isFunctionType } from "./type-abstractness.js";

type TypeMemberKind = "method" | "field";

export interface EcmascriptMemberCounts {
  methodCount: number;
  fieldCount: number;
  /** A class body's async instance methods; absent for an interface or object type. */
  asyncMethodCount?: number;
}

/** Return-type heads that make a method async without the keyword. */
const PROMISE_TYPE_HEADS: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

/** Field values that make a class field a method (`handler = () => …`). */
const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

/** Constructor-parameter modifiers that turn the parameter into a field of the class. */
const PARAMETER_PROPERTY_MODIFIERS: ReadonlySet<string> = new Set(["accessibility_modifier", "readonly"]);

function memberName(member: AstNode): string | undefined {
  return (member.childForFieldName("name") ?? member.childForFieldName("property"))?.text;
}

/** `get x` / `set x` — the keyword token, never a member NAMED `get`. */
function isAccessor(member: AstNode): boolean {
  return member.children.some((c) => c.type === "get" || c.type === "set");
}

/** The type a `type_annotation` field wraps. */
function annotatedType(member: AstNode): AstNode | undefined {
  return member.childForFieldName("type")?.namedChildren[0];
}

/** `async m()`, or a method whose declared return type is headed by `Promise` / `PromiseLike`. */
function isAsyncMethod(member: AstNode): boolean {
  if (member.children.some((c) => c.type === "async")) return true;
  const returned = annotatedReturnType(member);
  const head = returned?.type === "generic_type" ? returned.childForFieldName("name") : returned;
  return head !== null && head !== undefined && PROMISE_TYPE_HEADS.has(head.text);
}

/** The type a method's `return_type` annotation wraps. */
function annotatedReturnType(member: AstNode): AstNode | undefined {
  return member.childForFieldName("return_type")?.namedChildren[0];
}

function isStaticMember(member: AstNode): boolean {
  return member.children.some((c) => c.type === "static");
}

function classFieldKind(field: AstNode): TypeMemberKind {
  if (field.children.some((c) => c.type === "accessor")) return "field";
  const value = field.childForFieldName("value");
  if (value !== null && value !== undefined && FUNCTION_VALUE_TYPES.has(value.type)) return "method";
  return isFunctionType(annotatedType(field)) ? "method" : "field";
}

function recordParameterProperties(constructor: AstNode, record: (name: string, kind: TypeMemberKind) => void): void {
  const parameters = constructor.childForFieldName("parameters");
  for (const parameter of parameters?.namedChildren ?? []) {
    if (!parameter.namedChildren.some((c) => PARAMETER_PROPERTY_MODIFIERS.has(c.type))) continue;
    const name = parameter.childForFieldName("pattern")?.text;
    if (name !== undefined) record(name, "field");
  }
}

function tally(visit: (record: (name: string, kind: TypeMemberKind) => void) => void): EcmascriptMemberCounts {
  const kinds = new Map<string, TypeMemberKind>();
  visit((name, kind) => {
    if (!kinds.has(name)) kinds.set(name, kind);
  });
  let methodCount = 0;
  for (const kind of kinds.values()) if (kind === "method") methodCount++;
  return { methodCount, fieldCount: kinds.size - methodCount };
}

/** A `class_body`'s census (a class declaration or a class expression), async instance methods included. */
export function classBodyMemberCounts(body: AstNode | null | undefined): EcmascriptMemberCounts {
  const asyncNames = new Set<string>();
  const recordMethod = (member: AstNode, name: string, record: (name: string, kind: TypeMemberKind) => void): void => {
    if (isAccessor(member)) {
      record(name, "field");
      return;
    }
    record(name, "method");
    if (!isStaticMember(member) && isAsyncMethod(member)) asyncNames.add(name);
  };
  const counts = tally((record) => {
    for (const member of body?.namedChildren ?? []) {
      const name = memberName(member);
      switch (member.type) {
        case "method_definition":
          if (name === "constructor") recordParameterProperties(member, record);
          else if (name !== undefined) recordMethod(member, name, record);
          break;
        case "method_signature":
        case "abstract_method_signature":
          if (name !== undefined) recordMethod(member, name, record);
          break;
        case "public_field_definition":
        case "field_definition":
          if (name !== undefined) record(name, classFieldKind(member));
          break;
        default:
          break;
      }
    }
  });
  return { ...counts, asyncMethodCount: asyncNames.size };
}

/** An `interface_body`'s or an `object_type`'s census. */
export function objectTypeMemberCounts(body: AstNode | null | undefined): EcmascriptMemberCounts {
  return tally((record) => {
    for (const member of body?.namedChildren ?? []) {
      const name = memberName(member);
      switch (member.type) {
        case "method_signature":
          if (name !== undefined) record(name, isAccessor(member) ? "field" : "method");
          break;
        case "property_signature":
          if (name !== undefined) record(name, isFunctionType(annotatedType(member)) ? "method" : "field");
          break;
        case "call_signature":
          record("()", "method");
          break;
        case "construct_signature":
          record("new()", "method");
          break;
        default:
          break;
      }
    }
  });
}
