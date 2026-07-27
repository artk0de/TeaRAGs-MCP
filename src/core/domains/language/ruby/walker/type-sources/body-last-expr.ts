/**
 * Service-entry `call` / `perform` body last-expression RETURN-type source (G2).
 *
 * Inspects the LAST expression of a service-entry method body and emits a
 * `kind:"return"` fact for the conservative shapes below, feeding the SAME
 * `RubyTypeFactStore` (so `structuredReturnTypes["Svc#call"]` narrows the
 * `result = Svc.call(...); result.successful?` fan-out in the codegraph):
 *
 *   - `Const.new(...)`                          → instance(Const)
 *   - `Const.new(...).freeze` / `.tap { }` tail → instance(Const) (receiver passthrough)
 *   - a local var OR `@ivar` whose LAST (single) assignment in the body is one of
 *     the above → instance(Const)
 *   - a type-guard COERCION ternary `X.is_a?(C) ? X : <expr typing to C>` → instance(C)
 *
 * SILENCE (precision, never fabricate): branching returns, opaque method-call
 * tails, UNGUARDED ternaries, reassigned bindings, and non-const `new` receivers
 * emit NO fact — a wrong return type poisons every downstream chain hop.
 *
 * ── WHY THE IVAR + COERCION-TERNARY SHAPES (bd tea-rags-mcp-j9xpf) ──
 * The `Const.new` tail types hand-rolled service objects; the DOMINANT Rails
 * service-object base does neither. Ground truth (taxdome `lib/kind_of_service.rb`,
 * 2 167 includers) ends its `#call` in the ivar `@result`, assigned exactly once
 * from `raw.is_a?(KindOfService::Result) ? raw : KindOfService::Result.new(raw)`.
 * Both additions stay inside the conservative contract: an `@ivar` is a binding
 * exactly like a local (the same single-assignment discipline applies), and a
 * type-guard ternary is sound OCCURRENCE typing — the guard PROVES the true
 * branch is a `C`, and the false branch must independently type to the SAME `C`,
 * so the ternary carries no union. Neither widens to branching or opaque tails.
 *
 * ── SPEC TENSION (resolved by CONVENTION-bounding, not the run-global gate) ──
 * The design (`2026-07-10-service-result-return-types-design.md`) gates body
 * inspection on `ctx.selfDispatchTemplates` + `selfInstantiatingClassMethods` —
 * but those run-global sets are built at the provider's pass-1→pass-2 barrier
 * (trajectory layer), unreachable from an inline per-file type-source (walker
 * layer, no run-global state) and un-importable (the dependency-direction guard
 * forbids language → trajectory). Instead the gate is the SERVICE CONVENTION:
 * only method defs named `call` / `perform` (instance `def call` / class-form
 * `def self.call`) are inspected. That is O(service-convention defs) — on a Rails
 * corpus (taxdome: ~85 `#call` + ~2.5k `#perform`), never O(all 72k methods) —
 * satisfying the design's performance intent without the unreachable channel.
 *
 * ── LOCAL-BINDINGS BOUNDARY (no store double-emit) ──
 * `walker/local-bindings.ts::collectRubyBodyReturnTypes` already infers a
 * body-last-expression return for EVERY method via `constInstanceType`, but keyed
 * by the BARE method name into the FLAT `functionReturnTypes` channel
 * (`returnTypeOf` fallback path #4). This source is its scope-precise sibling:
 * it fills the `structuredReturnTypes` `"Class#method"` channel (`returnTypeOf`
 * path #1, which WINS), and it ADDS shapes the flat inference does not cover
 * (`.freeze`/`.tap` tails, single-assignment locals). The two live in different
 * channels — no `RubyTypeFactStore` coordinate collides between them — and they
 * agree on the plain `Const.new` case (structured just wins). Within the store,
 * the only same-coordinate collision is a YARD `@return` on the same `call`,
 * where `DEFAULT_SOURCE_ORDER` (yard > associations > body-last-expr) lets the
 * annotation win.
 *
 * Runtime imports (`constInstanceType`, `catalogueForGemfile`) stay cycle-free:
 * `walker.ts` is TYPE-imported only, mirroring `associations.ts` / `yard.ts` /
 * `ast-inference.ts` so `INLINE_TYPE_SOURCES` never observes an undefined source.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyDslCatalogue } from "../../dsl/index.js";
import { catalogueForGemfile } from "../../gemfile.js";
import { readScopeResolution } from "../ast-utils.js";
import type { RubyExtractInput } from "../walker.js";
import { constInstanceType } from "./ast-inference.js";
import type { RubyInlineTypeSource, RubyTypeFact } from "./types.js";

/** Service-entry method conventions the gate inspects — the O(service defs) bound. */
const SERVICE_ENTRY_METHODS = new Set(["call", "perform"]);

/** Tail methods returning their receiver unchanged (`Const.new.freeze` / `Const.new.tap { }`). */
const RECEIVER_PASSTHROUGH_TAIL_METHODS = new Set(["freeze", "tap"]);

/**
 * Runtime type-guard predicates whose TRUTHY branch proves the receiver is an
 * instance of the constant argument. `instance_of?` is stricter than `is_a?` /
 * `kind_of?` (exact class, no ancestry) — strictly narrower, so it is equally
 * sound for the coercion rule.
 */
const TYPE_GUARD_PREDICATES = new Set(["is_a?", "kind_of?", "instance_of?"]);

/** A bare or `::`-scoped Ruby constant name. */
const CONST_NAME = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;

/** AST node types that BIND a name in a method body — a local var or an `@ivar`. */
function isBindingNode(node: AstNode | null): boolean {
  return node?.type === "identifier" || node?.type === "instance_variable";
}

/** The constant an AST node names (`Result`, `Ns::Result`), or `null` when it is not one. */
function constNameOf(node: AstNode): string | null {
  const text = node.type === "scope_resolution" ? readScopeResolution(node) : node.text;
  return CONST_NAME.test(text) ? text : null;
}

/**
 * A type-guard COERCION ternary — `X.is_a?(C) ? X : <expr typing to C>` → `C`.
 *
 * Sound occurrence typing, not a widening: the guard proves the CONSEQUENCE
 * branch (which must be the guarded expression VERBATIM) is a `C`, and the
 * ALTERNATIVE branch must independently type to the SAME `C` via
 * {@link tailInstanceConst}. Both branches therefore carry `C` and the ternary
 * has no union. Any deviation — a different constant on the false branch, a
 * non-guard condition, a consequence that is not the guarded expression, a
 * non-constant guard argument — yields `null` (silence).
 */
function coercionTernaryConst(node: AstNode, catalogue: RubyDslCatalogue): string | null {
  if (node.type !== "conditional") return null;
  const condition = node.childForFieldName("condition");
  const consequence = node.childForFieldName("consequence");
  const alternative = node.childForFieldName("alternative");
  if (!condition || !consequence || !alternative) return null;
  if (condition.type !== "call" && condition.type !== "method_call") return null;
  const predicate = condition.childForFieldName("method");
  const guarded = condition.childForFieldName("receiver");
  if (!predicate || !guarded || !TYPE_GUARD_PREDICATES.has(predicate.text)) return null;
  const args = condition.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 1) return null;
  const guardConst = constNameOf(args[0]);
  if (guardConst === null) return null;
  // The guard only says something about the expression it tested.
  if (consequence.text !== guarded.text) return null;
  return tailInstanceConst(alternative, catalogue) === guardConst ? guardConst : null;
}

/**
 * The constant an expression evaluates to as an INSTANCE, peeling receiver-
 * passthrough tails (`.freeze` / `.tap { }`) and type-guard coercion ternaries
 * before delegating to {@link constInstanceType}. `null` = not a statically-known
 * instance (silence).
 */
function tailInstanceConst(node: AstNode, catalogue: RubyDslCatalogue): string | null {
  const direct = constInstanceType(node, catalogue);
  if (direct !== null) return direct;
  const coerced = coercionTernaryConst(node, catalogue);
  if (coerced !== null) return coerced;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const method = node.childForFieldName("method");
  const receiver = node.childForFieldName("receiver");
  if (!method || !receiver) return null;
  if (!RECEIVER_PASSTHROUGH_TAIL_METHODS.has(method.text)) return null;
  return tailInstanceConst(receiver, catalogue);
}

/**
 * The body's last value-producing statement, unwrapping an explicit `return EXPR`
 * and skipping `rescue`/`ensure`/`else` tails — mirrors the tail selection in
 * `collectRubyBodyReturnTypes` so both channels see the same last expression.
 */
function lastBodyExpression(body: AstNode): AstNode | null {
  const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
  let last = stmts[stmts.length - 1];
  if (!last) return null;
  if (last.type === "return") {
    const arg = last.namedChildren[0];
    if (!arg) return null;
    last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
    if (!last) return null;
  }
  return last;
}

/**
 * The constant a bare binding tail — a local var (`result`) or an `@ivar`
 * (`@result`) — was assigned, IFF it is assigned EXACTLY ONCE in the method body
 * with a `Const.new`(-passthrough / -coercion) RHS. Any reassignment — a second
 * plain assignment, an operator assignment (`+=`/`||=`), a multiple-assignment
 * target, or a reassignment inside a block (blocks share the method's local
 * scope, and ivars are not block-scoped at all) — yields `null` (silence). Zero
 * assignments (a method-call tail, or an ivar assigned in another method such as
 * `initialize`) also yields `null`.
 *
 * Ivars and locals share this rule because they share the observable property it
 * relies on: within ONE body, a single unconditional binding site determines the
 * value the tail reads. The rule is body-scoped by design — an ivar written by a
 * sibling method is deliberately NOT consulted (that would need flow analysis
 * across the class).
 */
function singleAssignmentConst(body: AstNode, bindingName: string, catalogue: RubyDslCatalogue): string | null {
  // One entry per assignment event to `bindingName`; a plain `bindingName = EXPR`
  // carries its RHS, every non-plain event (operator / multiple assignment) carries null.
  const events: (AstNode | null)[] = [];
  const scan = (n: AstNode): void => {
    // Nested def/class/module start a new scope; blocks do NOT — descend them.
    if (n.type === "method" || n.type === "singleton_method" || n.type === "class" || n.type === "module") return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      if (isBindingNode(lhs) && lhs?.text === bindingName) {
        events.push(n.childForFieldName("right"));
      } else if (lhs?.type === "left_assignment_list" && lhs.namedChildren.some((t) => t.text === bindingName)) {
        events.push(null); // multiple-assignment target — not a clean single-assign
      }
    } else if (n.type === "operator_assignment") {
      const lhs = n.childForFieldName("left");
      if (isBindingNode(lhs) && lhs?.text === bindingName) events.push(null); // `+=` / `||=`
    }
    for (const child of n.children) scan(child);
  };
  for (const child of body.children) scan(child);
  if (events.length !== 1) return null; // 0 = method-call tail; >1 = reassigned
  const rhs = events[0];
  if (!rhs) return null; // the single event was a non-plain assignment
  return tailInstanceConst(rhs, catalogue);
}

/** Emit the return fact for one service-entry def, if its body last expression is a conservative shape. */
function emitServiceReturnFact(
  defNode: AstNode,
  scope: readonly string[],
  catalogue: RubyDslCatalogue,
  out: RubyTypeFact[],
): void {
  const nameNode = defNode.childForFieldName("name");
  if (!nameNode || !SERVICE_ENTRY_METHODS.has(nameNode.text)) return;
  const body = defNode.childForFieldName("body");
  if (!body) return;
  const last = lastBodyExpression(body);
  if (!last) return;
  const constName = isBindingNode(last)
    ? singleAssignmentConst(body, last.text, catalogue)
    : tailInstanceConst(last, catalogue);
  if (constName === null) return;
  out.push({
    kind: "return",
    source: "body-last-expr",
    symbolScope: [...scope],
    methodName: nameNode.text,
    type: { form: "instance", name: constName },
  });
}

/**
 * Walk the tree tracking the enclosing class/module scope (mirroring
 * `collectAssociationReturnFacts` / `buildDefScopeMap`), inspecting each
 * `call` / `perform` def and attributing its return fact to that scope. A
 * `def self.call` singleton is attributed to the same enclosing class as the
 * instance `#call` — the store keys both as `Class#call`.
 */
function collectServiceReturnFacts(root: AstNode, catalogue: RubyDslCatalogue): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  const walkScope = (node: AstNode, scope: readonly string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
        const body = node.childForFieldName("body");
        const nextScope = [...scope, ...localName.split("::")];
        for (const child of (body ?? node).children) walkScope(child, nextScope);
        return;
      }
      for (const child of node.children) walkScope(child, scope);
      return;
    }
    if (node.type === "method" || node.type === "singleton_method") {
      emitServiceReturnFact(node, scope, catalogue, facts);
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return facts;
}

export const rubyBodyLastExprTypeSource: RubyInlineTypeSource = {
  name: "body-last-expr",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const root = input.tree?.rootNode;
    if (!root) return [];
    // Gem-gated `instanceReturning` facet (mirrors ast-inference); undefined → FULL.
    const catalogue = catalogueForGemfile(input.gemfileContent);
    return collectServiceReturnFacts(root, catalogue);
  },
};
