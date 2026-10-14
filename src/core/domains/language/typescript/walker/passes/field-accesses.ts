/**
 * TypeScript field accesses (bd tea-rags-mcp-zy6hx, D0) — one
 * `FileExtraction.fieldAccesses` fact per site where a class method touches a
 * field, in source order, for `cg_symbols_edges_field`:
 *
 *   | site                                  | ownerKind | ownerType          | receiver |
 *   | ------------------------------------- | --------- | ------------------ | -------- |
 *   | `this.x` / `this.#x` in a method      | self      | enclosing class    | —        |
 *   | `this.x` in a static method           | class     | enclosing class    | —        |
 *   | `Cls.x` inside class `Cls`            | class     | `Cls`              | —        |
 *   | `p.x`, `p: T` a method parameter      | param     | `T` as written     | `p`      |
 *   | `p.x`, `p` an untyped parameter       | unknown   | —                  | `p`      |
 *
 * A plain read is `read`, an assignment target `write`, a compound assignment
 * or `++` / `--` a `read` then a `write`, and each property destructured out of
 * an owner (`const { a } = this`) a `read`. A member that is the callee of a
 * call is a method call — already a call edge — and is not a field access;
 * `this.x.m()` reads `x`. Only the first hop off the owner is recorded, and
 * nothing is recorded for a local, an import or a module value.
 *
 * Accesses count only inside a class method, constructor, accessor or
 * class-property arrow function, attributed to that member's own chunk id —
 * the base id the walker composes, never a chunker `#partN`. `this` inside a
 * nested `function`, object-literal method or class expression is not the
 * member's receiver and is skipped; an arrow inherits it. A nested function's
 * own parameter shadows the member's parameter of the same name.
 *
 * A parameter's type is read exactly as the walker's typed-parameter binding
 * reads it (`extractTypeNameFromAnnotation`, one `type` alias hop), so the
 * owner name agrees with the `localBindings` the resolver sees.
 *
 * The pass is ECMAScript's, not TypeScript's alone (bd tea-rags-mcp-p1w1c):
 * the class-member, `this`, member-expression and pattern node shapes are
 * shared by both grammars, so JavaScript runs this same collector through
 * `ecmascriptFieldAccessFacetPass` with its own `EcmascriptParameterTypeReader`.
 * What differs is how a parameter is spelled and typed — TypeScript wraps it in
 * `required_parameter` / `optional_parameter` with an annotation, JavaScript
 * writes a bare `identifier` or a default-valued `assignment_pattern` and never
 * a type — and that a JavaScript class-property arrow owns no chunk (see
 * `memberFunction`).
 */

import { isSameAstNode, type AstNode } from "../../../../../contracts/types/ast.js";
import type { FieldAccessFact, FieldAccessKind, FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../../../contracts/types/language.js";
import { innermostChunkSymbolId, symbolIdNames, type ExtractionFacetPass } from "../../../kernel/index.js";
import { collectTypeAliases, extractTypeNameFromAnnotation } from "../walker.js";
import { ecmascriptBindingSites } from "./identifier-declarations.js";

/** The member whose body is being read: who `this` is and which parameters it declares. */
interface FieldAccessMemberScope {
  readonly symbolId: string;
  readonly className: string | undefined;
  readonly isStatic: boolean;
  /** False below a nested `function` / object method, where `this` is no longer the member's. */
  readonly thisBound: boolean;
  /** Declared parameter → its written type name, `null` when untyped. */
  readonly params: ReadonlyMap<string, string | null>;
}

type FieldAccessOwner = Pick<FieldAccessFact, "ownerKind" | "ownerType" | "receiver">;

/** A plainly named parameter and its written type, `null` when untyped. */
export interface EcmascriptDeclaredParameter {
  readonly name: string;
  readonly type: string | null;
}

/**
 * Per file, a reader of one parameter node: its plain name and written type, or
 * `undefined` for a destructured / rest parameter, which names no receiver.
 */
export type EcmascriptParameterTypeReader = (
  root: AstNode,
) => (param: AstNode) => EcmascriptDeclaredParameter | undefined;

const CLASS_NODE_TYPES: ReadonlySet<string> = new Set(["class_declaration", "abstract_class_declaration", "class"]);

/** Function-like nodes that rebind `this`; an `arrow_function` is the one that does not. */
const THIS_REBINDING_FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "method_definition",
]);

const FIELD_NAME_TYPES: ReadonlySet<string> = new Set(["property_identifier", "private_property_identifier"]);

/** Pattern wrappers a write target can sit in: `[this.a] = …`, `({ k: this.a } = …)`. */
const ASSIGNMENT_PATTERN_TYPES: ReadonlySet<string> = new Set([
  "array_pattern",
  "object_pattern",
  "pair_pattern",
  "rest_pattern",
  "assignment_pattern",
  "object_assignment_pattern",
]);

function parameterNodes(fn: AstNode): readonly AstNode[] {
  const single = fn.childForFieldName("parameter");
  if (single !== null) return [single];
  return fn.childForFieldName("parameters")?.namedChildren ?? [];
}

/** The names a function's parameter list binds — every name of a destructuring pattern too. */
function boundParameterNames(fn: AstNode): string[] {
  return parameterNodes(fn).flatMap((param) => {
    const pattern =
      param.type === "required_parameter" || param.type === "optional_parameter"
        ? param.childForFieldName("pattern")
        : param;
    return ecmascriptBindingSites(pattern, "param").map((site) => site.nameNode.text);
  });
}

/** TypeScript: a bare or annotated parameter, its type read through one `type` alias hop. */
const readTypescriptParameterType: EcmascriptParameterTypeReader = (root) => {
  const typeAliases = collectTypeAliases(root);
  return (param) => {
    if (param.type === "identifier") return { name: param.text, type: null };
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") return undefined;
    const pattern = param.childForFieldName("pattern");
    if (pattern?.type !== "identifier") return undefined;
    const annotation = param.children.find((child) => child.type === "type_annotation");
    return { name: pattern.text, type: extractTypeNameFromAnnotation(annotation, typeAliases) };
  };
};

/** Each plainly named parameter with its written type; destructured parameters name no receiver. */
function declaredParameterTypes(
  fn: AstNode,
  readParameter: (param: AstNode) => EcmascriptDeclaredParameter | undefined,
): Map<string, string | null> {
  const params = new Map<string, string | null>();
  for (const param of parameterNodes(fn)) {
    const declared = readParameter(param);
    if (declared !== undefined) params.set(declared.name, declared.type);
  }
  return params;
}

/**
 * The function a class member's accesses live in: the method itself, or a
 * property's arrow value. JavaScript's `field_definition` is not read: no chunk
 * carries a JS class-property function (`classPropertyFunction` answers only
 * TypeScript's `public_field_definition`), so there is no member id to own its
 * accesses, and the field is walked like any other initializer.
 */
function memberFunction(member: AstNode): AstNode | null {
  if (member.type === "method_definition") return member;
  if (member.type !== "public_field_definition") return null;
  const value = member.childForFieldName("value");
  return value?.type === "arrow_function" ? value : null;
}

function memberSymbolId(member: AstNode, chunks: WalkContext["chunks"]): string | undefined {
  const name = member.childForFieldName("name");
  if (name === null) return undefined;
  const line = name.startPosition.row + 1;
  return innermostChunkSymbolId(
    line,
    chunks.filter((chunk) => symbolIdNames(chunk.symbolId, name.text)),
  );
}

function memberScope(
  member: AstNode,
  fn: AstNode,
  chunks: WalkContext["chunks"],
  readParameter: (param: AstNode) => EcmascriptDeclaredParameter | undefined,
): FieldAccessMemberScope | undefined {
  const symbolId = memberSymbolId(member, chunks);
  if (symbolId === undefined) return undefined;
  const classNode = member.parent?.parent;
  const className =
    classNode && CLASS_NODE_TYPES.has(classNode.type) ? classNode.childForFieldName("name")?.text : undefined;
  return {
    symbolId,
    className,
    isStatic: member.children.some((child) => child.type === "static"),
    thisBound: true,
    params: declaredParameterTypes(fn, readParameter),
  };
}

/** A nested function: its own parameters shadow the member's, and a non-arrow rebinds `this`. */
function nestedFunctionScope(fn: AstNode, scope: FieldAccessMemberScope): FieldAccessMemberScope {
  const shadowed = boundParameterNames(fn);
  const thisBound = scope.thisBound && !THIS_REBINDING_FUNCTION_TYPES.has(fn.type);
  if (shadowed.length === 0 && thisBound === scope.thisBound) return scope;
  const params = new Map(scope.params);
  for (const name of shadowed) params.delete(name);
  return { ...scope, thisBound, params };
}

function ownerOf(object: AstNode, scope: FieldAccessMemberScope): FieldAccessOwner | undefined {
  if (object.type === "this") {
    if (!scope.thisBound) return undefined;
    if (scope.className === undefined) return { ownerKind: "unknown" };
    return { ownerKind: scope.isStatic ? "class" : "self", ownerType: scope.className };
  }
  if (object.type !== "identifier") return undefined;
  const name = object.text;
  if (scope.params.has(name)) {
    const type = scope.params.get(name);
    return type ? { ownerKind: "param", ownerType: type, receiver: name } : { ownerKind: "unknown", receiver: name };
  }
  if (name === scope.className) return { ownerKind: "class", ownerType: name };
  return undefined;
}

/** True when `node` is the target of an assignment, possibly inside a destructuring pattern. */
function isAssignmentTarget(node: AstNode): boolean {
  let current = node;
  let { parent } = current;
  while (parent !== null) {
    if (parent.type === "assignment_expression") return isSameAstNode(parent.childForFieldName("left"), current);
    if (!ASSIGNMENT_PATTERN_TYPES.has(parent.type)) return false;
    current = parent;
    ({ parent } = current);
  }
  return false;
}

/** How a `owner.field` member expression is used; `null` for a method call, which is no field access. */
function accessKindsOf(member: AstNode): readonly FieldAccessKind[] | null {
  const { parent } = member;
  if (parent === null) return ["read"];
  if (parent.type === "call_expression" && isSameAstNode(parent.childForFieldName("function"), member)) return null;
  if (parent.type === "augmented_assignment_expression" || parent.type === "update_expression") {
    return ["read", "write"];
  }
  if (parent.type === "unary_expression" && parent.children[0]?.type === "delete") return ["write"];
  return isAssignmentTarget(member) ? ["write"] : ["read"];
}

/** The property names an object pattern takes out of its source: `{ a, b: c, d = 1 }` → a, b, d. */
function destructuredPropertyNames(pattern: AstNode): AstNode[] {
  const names: AstNode[] = [];
  for (const child of pattern.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") names.push(child);
    else if (child.type === "pair_pattern") {
      const key = child.childForFieldName("key");
      if (key !== null && FIELD_NAME_TYPES.has(key.type)) names.push(key);
    } else if (child.type === "object_assignment_pattern") {
      const left = child.childForFieldName("left");
      if (left?.type === "shorthand_property_identifier_pattern") names.push(left);
    }
  }
  return names;
}

function fact(
  scope: FieldAccessMemberScope,
  owner: FieldAccessOwner,
  fieldName: string,
  accessKind: FieldAccessKind,
  line: number,
): FieldAccessFact {
  return {
    symbolId: scope.symbolId,
    ownerKind: owner.ownerKind,
    ...(owner.ownerType === undefined ? {} : { ownerType: owner.ownerType }),
    ...(owner.receiver === undefined ? {} : { receiver: owner.receiver }),
    fieldName,
    accessKind,
    line,
  };
}

class FieldAccessCollector {
  readonly facts: FieldAccessFact[] = [];

  constructor(
    private readonly chunks: WalkContext["chunks"],
    private readonly readParameter: (param: AstNode) => EcmascriptDeclaredParameter | undefined,
  ) {}

  visit(node: AstNode, scope: FieldAccessMemberScope | undefined): void {
    if (node.type === "class_body") {
      this.visitClassBody(node);
      return;
    }
    let inner = scope;
    if (scope !== undefined) {
      if (node.type === "arrow_function" || THIS_REBINDING_FUNCTION_TYPES.has(node.type)) {
        inner = nestedFunctionScope(node, scope);
      } else if (node.type === "member_expression") {
        this.recordMember(node, scope);
      } else if (node.type === "variable_declarator") {
        this.recordDestructuring(node.childForFieldName("name"), node.childForFieldName("value"), scope);
      } else if (node.type === "assignment_expression") {
        this.recordDestructuring(node.childForFieldName("left"), node.childForFieldName("right"), scope);
      }
    }
    for (const child of node.children) this.visit(child, inner);
  }

  /** Members open their own scope; anything else in a class body (field initializers, static blocks) has none. */
  private visitClassBody(body: AstNode): void {
    for (const member of body.children) {
      const fn = memberFunction(member);
      const scope = fn === null ? undefined : memberScope(member, fn, this.chunks, this.readParameter);
      const fnBody = fn?.childForFieldName("body");
      if (scope !== undefined && fnBody) this.visit(fnBody, scope);
      else if (fn === null) this.visit(member, undefined);
    }
  }

  private recordMember(member: AstNode, scope: FieldAccessMemberScope): void {
    const object = member.childForFieldName("object");
    const property = member.childForFieldName("property");
    if (object === null || property === null || !FIELD_NAME_TYPES.has(property.type)) return;
    const owner = ownerOf(object, scope);
    if (owner === undefined) return;
    const kinds = accessKindsOf(member);
    if (kinds === null) return;
    const line = property.startPosition.row + 1;
    for (const kind of kinds) this.facts.push(fact(scope, owner, property.text, kind, line));
  }

  private recordDestructuring(target: AstNode | null, source: AstNode | null, scope: FieldAccessMemberScope): void {
    if (target?.type !== "object_pattern" || source === null) return;
    const owner = ownerOf(source, scope);
    if (owner === undefined) return;
    for (const name of destructuredPropertyNames(target)) {
      this.facts.push(fact(scope, owner, name.text, "read", name.startPosition.row + 1));
    }
  }
}

/** The field-access pass for an ECMAScript grammar, typing parameters through `readParameterType`. */
export function ecmascriptFieldAccessFacetPass(readParameterType: EcmascriptParameterTypeReader): ExtractionFacetPass {
  return {
    run: (root, ctx): Partial<FileExtraction> => {
      if (ctx.chunks.length === 0) return {};
      const collector = new FieldAccessCollector(ctx.chunks, readParameterType(root));
      collector.visit(root, undefined);
      return collector.facts.length > 0 ? { fieldAccesses: collector.facts } : {};
    },
  };
}

export const typescriptFieldAccessFacetPass: ExtractionFacetPass =
  ecmascriptFieldAccessFacetPass(readTypescriptParameterType);
