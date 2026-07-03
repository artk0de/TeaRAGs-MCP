import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../../dsl/index.js";
import { catalogueForGemfile } from "../../gemfile.js";
import {
  CONTAINER_BLOCK_ITERATION_METHODS,
  CONTAINER_ELEMENT_RETURNING_METHODS,
} from "../../resolver/type-propagation.js";
import { lexicalScopeFqName, readScopeResolution, walk } from "../ast-utils.js";
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
 * Walk a relation chain `Const.<rel>(...)[.<rel>(...)]*` down to its root
 * constant. Returns the fully-qualified const when the chain bottoms out at a
 * `YARD_CONST` receiver through only {@link RUBY_RELATION_RETURNING}; null
 * for any non-relation link (no guessing).
 */
function relationRootConst(node: AstNode, catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE): string | null {
  const asConst =
    node.type === "scope_resolution" ? readScopeResolution(node) : node.type === "constant" ? node.text : null;
  if (asConst && YARD_CONST.test(asConst)) return asConst;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const recv = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!recv || !method || !catalogue.relationReturning.has(method.text)) return null;
  return relationRootConst(recv, catalogue);
}

/** A call chain that is STILL a relation (no terminal instanceReturning verb):
 *  `Post.where(...)`, `Post.where(...).order(...)`. Returns the root constant —
 *  the relation's ELEMENT type — or null. Identifier-rooted chains return null
 *  (no guessing; the root type is unknown at walk time). */
export function relationElementConst(node: AstNode, catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const method = node.childForFieldName("method");
  if (!method || !catalogue.relationReturning.has(method.text)) return null;
  return relationRootConst(node, catalogue);
}

/**
 * Infer the INSTANCE type of an RHS expression that is a class-constant call
 * (`ClassName.new(...)` / `Model.find(...)` / `Model.create!(...)` …) or a
 * relation-tail chain (`Const.where(...).first`). Returns the fully-qualified
 * constant name when the receiver is a constant (or a relation chain rooted at
 * one) and the method is in {@link RUBY_INSTANCE_RETURNING};
 * otherwise null (bare factory calls, bare Relation chains, non-constant
 * receivers — never guessed).
 */
export function constInstanceType(node: AstNode, catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const receiver = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!receiver || !method) return null;
  const methodName = method.text;
  if (!catalogue.instanceReturning.has(methodName)) return null;
  const receiverText = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
  // Direct `ClassName.new` / `ClassName.find` — receiver is the constant itself.
  if (YARD_CONST.test(receiverText)) return receiverText;
  // B2 relation tail `Const.where(...).first` — receiver is a relation chain.
  return relationRootConst(receiver, catalogue);
}

/** `lhs ||= rhs` is the only operator assignment that BINDS a type: the
 *  memoization convention takes the RHS type for the happy-path receiver
 *  (nil branch ignored). `+=`/`-=`/`&&=` mutate or preserve — never bind. */
export function isOrAssignment(node: AstNode): boolean {
  return node.type === "operator_assignment" && node.children.some((c) => c.text === "||=");
}

/**
 * Collect the program's instantiation set for one Ruby file (bd
 * tea-rags-mcp-pffv): every fully-qualified constant instantiated via
 * `Klass.new` or a factory/finder in `RUBY_INSTANCE_RETURNING` — exactly the
 * sites {@link constInstanceType} already classifies. Deduped. The provider
 * unions these across files into the run-global RTA set used to prune CHA
 * cones. Pure AST walk; no symbol-table access (walker discipline).
 *
 * Keys are scope-aware lexical-fq via {@link lexicalScopeFqName}: `Cat.new`
 * inside `module Zoo` emits `"Zoo::Cat"`, matching the `sourceFqName` the
 * inheritance edge builder writes for the same nesting (pffv Task 5). Top-level
 * sites are unchanged (`"Cat"` at top level → `"Cat"`).
 */
export function collectRubyInstantiatedTypes(
  root: AstNode,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): string[] {
  const seen = new Set<string>();
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const body = node.childForFieldName("body");
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    if (node.type === "call" || node.type === "method_call") {
      const constText = constInstanceType(node, catalogue);
      if (constText) seen.add(lexicalScopeFqName(scope, constText));
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return [...seen];
}

/**
 * Element lift: `user = users.first` / `x = users[0]` on a container-bound
 * local. When the RHS is an `element_reference` (`users[0]`) or a call/
 * method_call whose method is in {@link CONTAINER_ELEMENT_RETURNING_METHODS}
 * (`users.first`), and the base is an identifier already bound to a container
 * in `bindings`, returns the lifted element type. Returns null otherwise (no
 * guessing): non-identifier base, unbound/non-container base, or a
 * non-element-returning method (`users.count`).
 */
function containerElementLift(
  rhs: AstNode,
  bindings: ReadonlyMap<string, { type: RubyTypeRef; line: number }>,
  line: number,
): RubyTypeRef | null {
  const base =
    rhs.type === "element_reference"
      ? rhs.childForFieldName("object")
      : rhs.type === "call" || rhs.type === "method_call"
        ? rhs.childForFieldName("receiver")
        : null;
  if (base?.type !== "identifier") return null;
  if (rhs.type !== "element_reference") {
    const method = rhs.childForFieldName("method");
    if (!method || !CONTAINER_ELEMENT_RETURNING_METHODS.has(method.text)) return null;
  }
  const binding = bindings.get(base.text);
  if (!binding || binding.line > line || binding.type.form !== "container") return null;
  return binding.type.element;
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
    // Gem-gated type-source grammar (adx5p.1b): compose the catalogue for this
    // project's Gemfile once; `instanceReturning` / `relationReturning` facets
    // gate `constInstanceType` / `relationElementConst`. undefined → FULL.
    const catalogue = catalogueForGemfile(input.gemfileContent);
    // Track per-variable most-recent binding for copy-propagation and
    // block-parameter element typing. Maps varName → { type, line }.
    // Pre-seeded with YARD @param types so block-iteration over a
    // YARD-typed collection (`posts.each { |p| }`) resolves `posts` to its
    // element type and binds the block param correctly — mirroring
    // `collectLocalBindingsForChunk`'s behaviour where yardByLine is applied
    // before the AST walk. YARD @param uses the ELEMENT type for collection
    // params (Array<Post> → "Post"), so no unwrapping is needed here.
    const latestBinding = new Map<string, { type: RubyTypeRef; line: number }>();
    for (const [defLine, params] of collectYardParamTypes(input.code)) {
      for (const [name, type] of Object.entries(params)) {
        latestBinding.set(name, {
          type: { form: "instance", name: type },
          line: defLine,
        });
      }
    }

    const emitFact = (name: string, type: RubyTypeRef, line: number): void => {
      facts.push({
        kind: "local",
        source: "ast",
        symbolScope: [],
        name,
        line,
        type,
      });
      latestBinding.set(name, { type, line });
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
            const type = constInstanceType(valueNode, catalogue);
            if (type) emitFact(nameNode.text, { form: "instance", name: type }, line);
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
            const bound = recvBinding.type.form === "container" ? recvBinding.type.element : recvBinding.type;
            if (firstParam) emitFact(firstParam.text, bound, line);
          }
        }
        return;
      }

      if (node.type !== "assignment" && !isOrAssignment(node)) return;
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
          const constType = constInstanceType(value, catalogue);
          if (constType) {
            emitFact(target.text, { form: "instance", name: constType }, line);
          } else if (value.type === "identifier") {
            const prev = latestBinding.get(value.text);
            if (prev && prev.line <= line) emitFact(target.text, prev.type, line);
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
        emitFact(varName, { form: "class", name: rhsConst }, line);
        return;
      }

      // Single assignment: class-constant instance call.
      const instType = constInstanceType(rhs, catalogue);
      if (instType) {
        emitFact(varName, { form: "instance", name: instType }, line);
        return;
      }

      // Bare relation assignment: `posts = Post.where(...)` — RHS is STILL a
      // relation (terminal verb is relation-returning, not instance-returning).
      // Emits a container fact so a later `posts.each { |p| }` unwraps to the
      // element type (F2).
      const relElement = relationElementConst(rhs, catalogue);
      if (relElement) {
        emitFact(varName, { form: "container", element: { form: "instance", name: relElement } }, line);
        return;
      }

      // Element lift: `user = users.first` / `x = users[0]` on a container-bound local.
      const lifted = containerElementLift(rhs, latestBinding, line);
      if (lifted) {
        emitFact(varName, lifted, line);
        return;
      }

      // Copy-propagation: `var = other_var` copies other_var's most-recent type.
      if (rhs.type === "identifier") {
        const prev = latestBinding.get(rhs.text);
        if (prev && prev.line <= line) emitFact(varName, prev.type, line);
      }
    });

    return facts;
  },
};
