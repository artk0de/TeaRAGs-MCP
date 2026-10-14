/**
 * Ruby field accesses (bd tea-rags-mcp-zy6hx, D0) — one
 * `FileExtraction.fieldAccesses` fact per site where a method touches a field,
 * in source order, for `cg_symbols_edges_field`:
 *
 *   | site                                         | ownerKind | ownerType        | receiver |
 *   | -------------------------------------------- | --------- | ---------------- | -------- |
 *   | `@x` in an instance method                   | self      | enclosing class  | —        |
 *   | `@x` in `def self.m` / `class << self`       | class     | enclosing class  | —        |
 *   | `@@x` in any method                          | class     | enclosing class  | —        |
 *   | `p.x`, `p` a parameter YARD types `[T]`      | param     | `T` as written   | `p`      |
 *   | `p.x`, any other declared parameter          | unknown   | —                | `p`      |
 *
 * The enclosing class is the owner the method's symbolId carries (`Shop::Cart`
 * for `Shop::Cart#add`), and whether `@x` is class-level is read off the same id
 * — the walker's `.` separator for a singleton method, `#` for an instance one.
 *
 * `p.x` is a method call in Ruby; it counts as an attribute access only on a
 * declared plain / optional / keyword parameter, with no arguments (not even
 * `()`), no block, and a name that is not a predicate or bang (`?` / `!`).
 * A pure read whose name is a core Ruby member (`RUBY_CORE_MEMBERS`: `to_s`, `dup`,
 * `class`, `size`, …) is a core method call, not an attribute, and records nothing; a
 * write to such a name is still an attribute writer. `self.x` and a bare `x` stay method edges, and nothing is recorded for a
 * local or a splat / block parameter. Only a bare-constant YARD `@param` types
 * the owner: `[Array<Order>]` names what the collection holds, not the receiver.
 *
 * A plain read is `read`; an assignment target — a multiple-assignment, splat
 * or nested target and a `rescue => @e` included — is `write`; `+=`, `||=`,
 * `&&=` are a `read` then a `write`. `instance_variable_get` /
 * `instance_variable_set` name the field dynamically and are not recorded.
 *
 * Accesses count only inside a method chunk — `def`, `def self.`, or a
 * `define_method` block the walker chunks — attributed to that method's base
 * id, never a chunker `#partN`. A class body outside a method and a top-level
 * `def` record nothing. A block or lambda keeps the method's `self`, its own
 * parameters shadowing the method's; an `instance_eval` / `class_eval` (or
 * `_exec` / `module_eval`) block rebinds `self` and is skipped, as is a nested
 * class, module or `class << self` body.
 */

import { isSameAstNode, type AstNode } from "../../../../../contracts/types/ast.js";
import type { FieldAccessFact, FieldAccessKind, FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../../../contracts/types/language.js";
import { innermostChunkSymbolId, symbolIdNames, type ExtractionFacetPass } from "../../../kernel/index.js";
import { RUBY_CORE_MEMBERS } from "../../dsl/core-members.js";
import { collectYardRawParamBrackets, YARD_CONST } from "../type-sources/yard.js";

/** The method whose body is being read: its id, who `self` is, and which parameters it declares. */
interface RubyFieldAccessMethodScope {
  readonly symbolId: string;
  /** The class / module the symbolId carries; undefined when the id names none recoverably. */
  readonly ownerType: string | undefined;
  /** True for a singleton method, where `@x` is class-level state. */
  readonly isClassLevel: boolean;
  /** Declared parameter → its YARD bare-constant type, `null` when untyped. */
  readonly params: ReadonlyMap<string, string | null>;
}

type RubyFieldAccessOwner = Pick<FieldAccessFact, "ownerKind" | "ownerType" | "receiver">;

const METHOD_NODE_TYPES: ReadonlySet<string> = new Set(["method", "singleton_method"]);

/** Bodies that run under a different `self`: a nested type body. */
const SELF_REBINDING_BODY_TYPES: ReadonlySet<string> = new Set(["class", "module", "singleton_class"]);

/** Calls whose block runs with `self` rebound to the receiver. */
const SELF_REBINDING_EVAL_METHODS: ReadonlySet<string> = new Set([
  "instance_eval",
  "instance_exec",
  "class_eval",
  "class_exec",
  "module_eval",
  "module_exec",
]);

const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set(["block", "do_block"]);

/** Wrappers a write target can sit in on the left of an assignment: `@a, (@b, *@c) = …`. */
const ASSIGNMENT_TARGET_LIST_TYPES: ReadonlySet<string> = new Set([
  "left_assignment_list",
  "destructured_left_assignment",
  "rest_assignment",
]);

/** The parameter kinds whose value is the argument itself, so `p.x` reads that object's attribute. */
const RECEIVER_PARAMETER_TYPES: ReadonlySet<string> = new Set(["optional_parameter", "keyword_parameter"]);

/** Every name a parameter list binds — splat, block and destructured parameters too. */
function boundParameterNames(params: AstNode | null): string[] {
  if (params === null) return [];
  const names: string[] = [];
  const stack: AstNode[] = [...params.namedChildren];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "identifier") names.push(node.text);
    else if (node.type === "destructured_parameter") stack.push(...node.namedChildren);
    else {
      const name = node.childForFieldName("name");
      if (name !== null) names.push(name.text);
    }
  }
  return names;
}

/** Each plain / optional / keyword parameter with its YARD type; splat and block parameters name no receiver. */
function declaredParameterTypes(
  params: AstNode | null,
  yardTypes: Readonly<Record<string, string>> | undefined,
): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const param of params?.namedChildren ?? []) {
    const nameNode = param.type === "identifier" ? param : null;
    const name = nameNode ?? (RECEIVER_PARAMETER_TYPES.has(param.type) ? param.childForFieldName("name") : null);
    if (name === null) continue;
    const raw = yardTypes?.[name.text]?.trim();
    declared.set(name.text, raw !== undefined && YARD_CONST.test(raw) ? raw : null);
  }
  return declared;
}

/** `define_method(:name)` / `define_method("name")` with a block → its method name, else null. */
function defineMethodName(call: AstNode): string | null {
  if (call.childForFieldName("method")?.text !== "define_method") return null;
  const block = call.childForFieldName("block");
  if (block === null || !BLOCK_NODE_TYPES.has(block.type)) return null;
  const operand = call.childForFieldName("arguments")?.namedChildren[0];
  if (operand?.type === "simple_symbol") return operand.text.slice(1);
  if (operand?.type === "string") {
    const content = operand.namedChildren;
    return content.length === 1 && content[0].type === "string_content" ? content[0].text : null;
  }
  return null;
}

function methodScope(
  name: AstNode,
  methodName: string,
  params: Map<string, string | null>,
  chunks: WalkContext["chunks"],
): RubyFieldAccessMethodScope | undefined {
  const line = name.startPosition.row + 1;
  const symbolId = innermostChunkSymbolId(
    line,
    chunks.filter((chunk) => symbolIdNames(chunk.symbolId, methodName)),
  );
  // A top-level `def` names no class: its `self` is `main`, not a field owner.
  if (symbolId === undefined || symbolId === methodName) return undefined;
  const ownerId = symbolId.slice(0, symbolId.length - methodName.length - 1);
  const separator = symbolId.charAt(ownerId.length);
  // A def nested inside another def carries the outer method in its prefix — no class to name.
  const ownerType = ownerId.includes("#") || ownerId.includes(".") ? undefined : ownerId;
  return { symbolId, ownerType, isClassLevel: separator === ".", params };
}

/** How an `@x` / `p.x` site is used: an assignment target is a write, a compound assignment both. */
function accessKindsOf(site: AstNode): readonly FieldAccessKind[] {
  let current = site;
  let { parent } = current;
  while (parent !== null) {
    if (parent.type === "operator_assignment") {
      return isSameAstNode(parent.childForFieldName("left"), current) ? ["read", "write"] : ["read"];
    }
    if (parent.type === "assignment") {
      return isSameAstNode(parent.childForFieldName("left"), current) ? ["write"] : ["read"];
    }
    if (parent.type === "exception_variable") return ["write"];
    if (!ASSIGNMENT_TARGET_LIST_TYPES.has(parent.type)) return ["read"];
    current = parent;
    ({ parent } = current);
  }
  return ["read"];
}

function fact(
  scope: RubyFieldAccessMethodScope,
  owner: RubyFieldAccessOwner,
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

class RubyFieldAccessCollector {
  readonly facts: FieldAccessFact[] = [];
  private yardParamTypesByDefLine: Map<number, Record<string, string>> | undefined;

  constructor(
    private readonly chunks: WalkContext["chunks"],
    private readonly code: string,
  ) {}

  visit(node: AstNode, scope: RubyFieldAccessMethodScope | undefined): void {
    if (METHOD_NODE_TYPES.has(node.type)) {
      this.visitChildren(node, this.defScope(node));
      return;
    }
    if (SELF_REBINDING_BODY_TYPES.has(node.type)) {
      this.visitChildren(node, undefined);
      return;
    }
    if (node.type === "call") {
      this.visitCall(node, scope);
      return;
    }
    if (scope !== undefined) {
      if (node.type === "instance_variable" || node.type === "class_variable") {
        this.recordVariable(node, scope);
      } else if (BLOCK_NODE_TYPES.has(node.type) || node.type === "lambda") {
        this.visitChildren(node, shadowedScope(scope, node.childForFieldName("parameters")));
        return;
      }
    }
    this.visitChildren(node, scope);
  }

  private visitChildren(node: AstNode, scope: RubyFieldAccessMethodScope | undefined): void {
    for (const child of node.children) this.visit(child, scope);
  }

  private visitCall(call: AstNode, scope: RubyFieldAccessMethodScope | undefined): void {
    const block = call.childForFieldName("block");
    const defined = defineMethodName(call);
    if (defined !== null && block !== null) {
      const params = block.childForFieldName("parameters");
      const inner = methodScope(call, defined, declaredParameterTypes(params, undefined), this.chunks);
      // The block's parameters ARE the defined method's: visit its children, not the
      // block itself, so they are not shadowed away as a nested block's would be.
      for (const child of call.children) {
        if (isSameAstNode(child, block)) this.visitChildren(block, inner);
        else this.visit(child, scope);
      }
      return;
    }
    if (scope === undefined) {
      this.visitChildren(call, undefined);
      return;
    }
    this.recordParameterAttribute(call, scope);
    const rebindsSelf = SELF_REBINDING_EVAL_METHODS.has(call.childForFieldName("method")?.text ?? "");
    for (const child of call.children) {
      this.visit(child, rebindsSelf && block !== null && isSameAstNode(child, block) ? undefined : scope);
    }
  }

  private defScope(def: AstNode): RubyFieldAccessMethodScope | undefined {
    const name = def.childForFieldName("name");
    if (name === null) return undefined;
    const params = def.childForFieldName("parameters");
    const yardTypes = params === null ? undefined : this.yardParamTypes().get(def.startPosition.row + 1);
    return methodScope(name, name.text, declaredParameterTypes(params, yardTypes), this.chunks);
  }

  private yardParamTypes(): Map<number, Record<string, string>> {
    this.yardParamTypesByDefLine ??= collectYardRawParamBrackets(this.code);
    return this.yardParamTypesByDefLine;
  }

  private recordVariable(variable: AstNode, scope: RubyFieldAccessMethodScope): void {
    const classLevel = variable.type === "class_variable" || scope.isClassLevel;
    const owner: RubyFieldAccessOwner =
      scope.ownerType === undefined
        ? { ownerKind: "unknown" }
        : { ownerKind: classLevel ? "class" : "self", ownerType: scope.ownerType };
    const line = variable.startPosition.row + 1;
    for (const kind of accessKindsOf(variable)) this.facts.push(fact(scope, owner, variable.text, kind, line));
  }

  /** `p.x` / `p.x = v` on a declared parameter: an argument-less, block-less attribute call. */
  private recordParameterAttribute(call: AstNode, scope: RubyFieldAccessMethodScope): void {
    const receiver = call.childForFieldName("receiver");
    const method = call.childForFieldName("method");
    if (receiver?.type !== "identifier" || method?.type !== "identifier") return;
    if (!scope.params.has(receiver.text)) return;
    if (call.childForFieldName("arguments") !== null || call.childForFieldName("block") !== null) return;
    if (method.text.endsWith("?") || method.text.endsWith("!")) return;
    const type = scope.params.get(receiver.text);
    const owner: RubyFieldAccessOwner = type
      ? { ownerKind: "param", ownerType: type, receiver: receiver.text }
      : { ownerKind: "unknown", receiver: receiver.text };
    const line = method.startPosition.row + 1;
    const kinds = accessKindsOf(call);
    // `p.to_s` / `p.dup` / `p.size` read a core Object/Kernel/Enumerable method, not an
    // attribute — Ruby cannot tell the two apart syntactically. A write (`p.size = 1`) can
    // only be an attribute writer, so it stays.
    if (RUBY_CORE_MEMBERS.has(method.text) && !kinds.includes("write")) return;
    for (const kind of kinds) this.facts.push(fact(scope, owner, method.text, kind, line));
  }
}

/** A block or lambda keeps `self`; its own parameters shadow the method's of the same name. */
function shadowedScope(scope: RubyFieldAccessMethodScope, params: AstNode | null): RubyFieldAccessMethodScope {
  const shadowed = boundParameterNames(params).filter((name) => scope.params.has(name));
  if (shadowed.length === 0) return scope;
  const remaining = new Map(scope.params);
  for (const name of shadowed) remaining.delete(name);
  return { ...scope, params: remaining };
}

export const rubyFieldAccessFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    if (ctx.chunks.length === 0) return {};
    const collector = new RubyFieldAccessCollector(ctx.chunks, ctx.code);
    collector.visit(root, undefined);
    return collector.facts.length > 0 ? { fieldAccesses: collector.facts } : {};
  },
};
