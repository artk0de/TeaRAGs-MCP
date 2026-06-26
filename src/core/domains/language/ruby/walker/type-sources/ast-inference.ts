import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { CONTAINER_BLOCK_ITERATION_METHODS } from "../../resolver/type-propagation.js";
import { readScopeResolution, walk } from "../ast-utils.js";
import type { RubyExtractInput } from "../walker.js";
import type { RubyInlineTypeSource, RubyTypeFact } from "./types.js";
import { collectYardParamTypes, YARD_CONST } from "./yard.js";

/**
 * Re-export of {@link CONTAINER_BLOCK_ITERATION_METHODS} from the type-propagation
 * engine — the single source of truth for block-iterator methods shared by
 * `rubyAstInferenceTypeSource` (walk-time block-param inference) and
 * `collectLocalBindingsForChunk`. Kept as a named export so callers that already
 * import `RUBY_BLOCK_ITERATOR_METHODS` from this module don't need a mechanical
 * import-path change.
 */
export const RUBY_BLOCK_ITERATOR_METHODS = CONTAINER_BLOCK_ITERATION_METHODS;

/**
 * Instance-returning methods on a class constant that bind a local to the
 * receiver's INSTANCE type. `new` is the universal constructor; the rest are
 * Rails/ActiveRecord factories and finders that return a single model instance
 * (not a Relation). Methods like `where` / `order` / `joins` return a Relation,
 * so chained `.first` / `.last` need separate Relation-aware tracking (not done
 * here). This is the single source of truth for the instance-returning set
 * (bd tea-rags-mcp-va9ng will later wire it onto ResolverConfig); the walker's
 * binding inference consumes it directly. Note `new` is handled separately as
 * the universal constructor and is NOT listed here.
 */
export const INSTANCE_RETURNING_METHODS = new Set([
  "find",
  "find!",
  "find_by",
  "find_by!",
  "create",
  "create!",
  "build",
  "first",
  "last",
  "take",
]);

/**
 * AR::Relation-returning query methods: `Const.where(...)` is a
 * `Relation<Const>`, and chaining another of these stays `Relation<Const>`
 * (same element type). A terminal instance-returning method
 * ({@link INSTANCE_RETURNING_METHODS}) on such a relation yields ONE `Const`
 * instance — so `Const.where(...).first` is typed `Const` (bd Increment B / B2).
 */
export const RELATION_RETURNING_METHODS = new Set([
  "where",
  "not",
  "order",
  "joins",
  "includes",
  "eager_load",
  "preload",
  "references",
  "group",
  "having",
  "limit",
  "offset",
  "distinct",
  "select",
  "reorder",
  "unscope",
  "except",
  "all",
  "readonly",
  "lock",
  "none",
]);

/**
 * Walk a relation chain `Const.<rel>(...)[.<rel>(...)]*` down to its root
 * constant. Returns the fully-qualified const when the chain bottoms out at a
 * `YARD_CONST` receiver through only {@link RELATION_RETURNING_METHODS}; null
 * for any non-relation link (no guessing).
 */
function relationRootConst(node: AstNode): string | null {
  const asConst =
    node.type === "scope_resolution" ? readScopeResolution(node) : node.type === "constant" ? node.text : null;
  if (asConst && YARD_CONST.test(asConst)) return asConst;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const recv = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!recv || !method || !RELATION_RETURNING_METHODS.has(method.text)) return null;
  return relationRootConst(recv);
}

/**
 * Infer the INSTANCE type of an RHS expression that is a class-constant call
 * (`ClassName.new(...)` / `Model.find(...)` / `Model.create!(...)` …) or a
 * relation-tail chain (`Const.where(...).first`). Returns the fully-qualified
 * constant name when the receiver is a constant (or a relation chain rooted at
 * one) and the method is `new` or in {@link INSTANCE_RETURNING_METHODS};
 * otherwise null (bare factory calls, bare Relation chains, non-constant
 * receivers — never guessed).
 */
export function constInstanceType(node: AstNode): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const receiver = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!receiver || !method) return null;
  const methodName = method.text;
  if (methodName !== "new" && !INSTANCE_RETURNING_METHODS.has(methodName)) return null;
  const receiverText = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
  // Direct `ClassName.new` / `ClassName.find` — receiver is the constant itself.
  if (YARD_CONST.test(receiverText)) return receiverText;
  // B2 relation tail `Const.where(...).first` — receiver is a relation chain.
  return relationRootConst(receiver);
}

/**
 * `rubyAstInferenceTypeSource` — walks the AST for a single Ruby file and
 * emits `kind: "local"` {@link RubyTypeFact} entries: one per inferred
 * local-variable binding produced by:
 *   - `var = ClassName.new(...)` / factory-finder calls
 *   - `var = CONST` (class-valued binding, `type.form = "class"`)
 *   - Copy-propagation `var = other_var` (inherits the most-recent type)
 *   - Multiple-assignment `a, b = X.new, Y.new` (paired positionally)
 *   - Param-default `def f(x = User.new)` — binds at the `def` line
 *
 * The adapter is NOT wired into `extractFromRubyFile` yet (Task 0.5 does
 * that). It is exercised by `ast-inference.test.ts` only.
 *
 * `line` is the 1-based assignment/def line; `type.form` is `"class"` when
 * the RHS is a bare constant (the var holds the class itself) and
 * `"instance"` for constructor/factory/finder/copy-propagation bindings.
 * `symbolScope` and `methodName` are intentionally empty at this relocation
 * stage — they are populated when the store wires the source (Task 0.5+).
 */
export const rubyAstInferenceTypeSource: RubyInlineTypeSource = {
  name: "ast",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const facts: RubyTypeFact[] = [];
    // Track per-variable most-recent binding for copy-propagation and
    // block-parameter element typing. Maps varName → { type, line }.
    // Pre-seeded with YARD @param types so block-iteration over a
    // YARD-typed collection (`posts.each { |p| }`) resolves `posts` to its
    // element type and binds the block param correctly — mirroring
    // `collectLocalBindingsForChunk`'s behaviour where yardByLine is applied
    // before the AST walk. YARD @param uses the ELEMENT type for collection
    // params (Array<Post> → "Post"), so no unwrapping is needed here.
    const latestBinding = new Map<string, { type: string; line: number }>();
    for (const [defLine, params] of collectYardParamTypes(input.code)) {
      for (const [name, type] of Object.entries(params)) {
        latestBinding.set(name, { type, line: defLine });
      }
    }

    const emitFact = (name: string, typeName: string, line: number, form: "class" | "instance"): void => {
      const typeRef: RubyTypeRef = { form, name: typeName };
      facts.push({ kind: "local", source: "ast", symbolScope: [], name, line, type: typeRef });
      latestBinding.set(name, { type: typeName, line });
    };

    walk(input.tree.rootNode, (node) => {
      const line = node.startPosition.row + 1;

      // Param-default inference: `def f(x = User.new)` binds `x` for the body at
      // the `def` line. Block params / untyped params are skipped (VTA scope).
      if (node.type === "method" || node.type === "singleton_method") {
        const params = node.childForFieldName("parameters");
        if (params) {
          for (const param of params.namedChildren) {
            if (param.type !== "optional_parameter") continue;
            const nameNode = param.childForFieldName("name");
            const valueNode = param.childForFieldName("value");
            if (nameNode?.type !== "identifier" || !valueNode) continue;
            const type = constInstanceType(valueNode);
            if (type) emitFact(nameNode.text, type, line, "instance");
          }
        }
        return;
      }

      // Block-parameter element typing: `coll.each { |e| ... }` binds `e` to
      // coll's resolved element type. Only the FIRST positional param (element);
      // subsequent params (index, accumulator) are skipped. VTA is sound only
      // when the receiver already has a binding in latestBinding.
      if (node.type === "block" || node.type === "do_block") {
        const { parent } = node;
        const callMethod = parent?.childForFieldName("method")?.text;
        const recvNode = parent?.childForFieldName("receiver");
        if (
          parent &&
          (parent.type === "call" || parent.type === "method_call") &&
          callMethod &&
          RUBY_BLOCK_ITERATOR_METHODS.has(callMethod) &&
          recvNode?.type === "identifier"
        ) {
          const recvBinding = latestBinding.get(recvNode.text);
          if (recvBinding && recvBinding.line <= line) {
            const paramsNode = node.childForFieldName("parameters"); // block_parameters
            const firstParam = paramsNode?.namedChildren.find((p) => p.type === "identifier");
            if (firstParam) emitFact(firstParam.text, recvBinding.type, line, "instance");
          }
        }
        return;
      }

      if (node.type !== "assignment") return;
      const lhs = node.childForFieldName("left");
      const rhs = node.childForFieldName("right");
      if (!lhs || !rhs) return;

      // Multiple assignment: `a, b = X.new, Y.new`. Pair positionally only when
      // the LHS identifier count matches the RHS element count (splat / uneven
      // arity is skipped — no guessing).
      if (lhs.type === "left_assignment_list" && rhs.type === "right_assignment_list") {
        const targets = lhs.namedChildren;
        const values = rhs.namedChildren;
        if (targets.length !== values.length) return;
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          const value = values[i];
          if (target?.type !== "identifier" || !value) continue;
          const constType = constInstanceType(value);
          if (constType) {
            emitFact(target.text, constType, line, "instance");
          } else if (value.type === "identifier") {
            const prev = latestBinding.get(value.text);
            if (prev && prev.line <= line) emitFact(target.text, prev.type, line, "instance");
          }
        }
        return;
      }

      if (lhs.type !== "identifier") return;
      const varName = lhs.text;

      // `var = CONST` — var holds the CLASS itself (not an instance). Bare constant
      // RHS only (a call RHS is handled by constInstanceType above).
      const rhsConst =
        rhs.type === "scope_resolution" ? readScopeResolution(rhs) : rhs.type === "constant" ? rhs.text : null;
      if (rhsConst && YARD_CONST.test(rhsConst)) {
        emitFact(varName, rhsConst, line, "class");
        return;
      }

      // Single assignment: class-constant instance call.
      const instType = constInstanceType(rhs);
      if (instType) {
        emitFact(varName, instType, line, "instance");
        return;
      }

      // Copy-propagation: `var = other_var` copies other_var's most-recent type.
      if (rhs.type === "identifier") {
        const prev = latestBinding.get(rhs.text);
        if (prev && prev.line <= line) emitFact(varName, prev.type, line, "instance");
      }
    });

    return facts;
  },
};
