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
 *   - a local var whose LAST (single) assignment is `Const.new(...)` → instance(Const)
 *
 * SILENCE (precision, never fabricate): branching returns, opaque method-call
 * tails, ternaries, reassigned locals, and non-const `new` receivers emit NO
 * fact — a wrong return type poisons every downstream chain hop.
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
 * The constant an expression evaluates to as an INSTANCE, peeling receiver-
 * passthrough tails (`.freeze` / `.tap { }`) before delegating to
 * {@link constInstanceType}. `null` = not a statically-known instance (silence).
 */
function tailInstanceConst(node: AstNode, catalogue: RubyDslCatalogue): string | null {
  const direct = constInstanceType(node, catalogue);
  if (direct !== null) return direct;
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
 * The constant a bare local-var tail (`result`) was assigned, IFF it is assigned
 * EXACTLY ONCE in the method body with a `Const.new`(-passthrough) RHS. Any
 * reassignment — a second plain assignment, an operator assignment (`+=`/`||=`),
 * a multiple-assignment target, or a reassignment inside a block (blocks share
 * the method's local scope) — yields `null` (silence). Zero assignments (a
 * method-call tail, not a local) also yields `null`.
 */
function singleAssignmentConst(body: AstNode, varName: string, catalogue: RubyDslCatalogue): string | null {
  // One entry per assignment event to `varName`; a plain `varName = EXPR` carries
  // its RHS, every non-plain event (operator / multiple assignment) carries null.
  const events: (AstNode | null)[] = [];
  const scan = (n: AstNode): void => {
    // Nested def/class/module start a new local scope; blocks do NOT — descend them.
    if (n.type === "method" || n.type === "singleton_method" || n.type === "class" || n.type === "module") return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      if (lhs?.type === "identifier" && lhs.text === varName) {
        events.push(n.childForFieldName("right"));
      } else if (lhs?.type === "left_assignment_list" && lhs.namedChildren.some((t) => t.text === varName)) {
        events.push(null); // multiple-assignment target — not a clean single-assign
      }
    } else if (n.type === "operator_assignment") {
      const lhs = n.childForFieldName("left");
      if (lhs?.type === "identifier" && lhs.text === varName) events.push(null); // `+=` / `||=`
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
  const constName =
    last.type === "identifier" ? singleAssignmentConst(body, last.text, catalogue) : tailInstanceConst(last, catalogue);
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
