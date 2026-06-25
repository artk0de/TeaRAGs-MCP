import type { AstNode } from "../../../../contracts/types/ast.js";
import { resolveLocalBindingType, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import { readScopeResolution, walk } from "./ast-utils.js";
import { constInstanceType } from "./type-sources/ast-inference.js";
import { YARD_CONST } from "./type-sources/yard.js";

export { collectYardParamTypes, collectYardReturnTypes, YARD_CONST } from "./type-sources/yard.js";
export { INSTANCE_RETURNING_METHODS, RELATION_RETURNING_METHODS } from "./type-sources/ast-inference.js";

/**
 * Enumerable / collection methods that yield each element to a block. When the
 * iterated receiver has a known element type, the FIRST positional block param
 * is that element type (bd Increment B / B-block).
 */
export const RUBY_BLOCK_ITERATOR_METHODS = new Set([
  "each",
  "map",
  "collect",
  "select",
  "filter",
  "filter_map",
  "reject",
  "find",
  "detect",
  "find_all",
  "flat_map",
  "each_with_index",
  "each_with_object",
  "group_by",
  "sort_by",
  "min_by",
  "max_by",
  "partition",
]);

/**
 * Env-gate for the Ruby local variable type inference path. When `false`,
 * walker emits `localBindings: undefined` and the resolver falls back to
 * legacy import + short-name resolution. Default `true`.
 */
export function localTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/**
 * Per-class `@ivar -> typeName` map for the universal `classFieldTypes` channel
 * (Ruby is the 5th implementation after TS/Java/Python/Rust). Walks each class /
 * module and records `@ivar = Const.new` (or instance-returning finder, via
 * {@link constInstanceType}) assignments found ANYWHERE in that class's own
 * method bodies — `initialize`, lazy memoization, setup helpers — but NOT in
 * nested classes, which get their own fq map. The class key is the fully
 * qualified scope-stack name (`Outer::Inner`), matching `collectRubyClassAncestors`
 * and the resolver's `ctx.callerScope.join("::")`. The `@`-prefixed field key
 * matches the call-site receiver text verbatim (`@client`). Mirrors
 * `collectPythonClassFieldTypes`: within-class conflict is last-write-wins; a
 * non-constructor RHS records nothing (the uppercase-constant gate lives in
 * `constInstanceType`).
 */
export function collectRubyIvarFieldTypes(root: AstNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      const body = node.childForFieldName("body");

      // Collect `@ivar = Const.new` across THIS class's own bodies. Stop at any
      // nested class/module — those are attributed to their own fq via the
      // walkScope recursion below.
      const fields: Record<string, string> = {};
      const collectIvars = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module") return;
        if (n.type === "assignment") {
          const lhs = n.childForFieldName("left");
          const rhs = n.childForFieldName("right");
          if (lhs?.type === "instance_variable" && rhs) {
            const type = constInstanceType(rhs);
            if (type) fields[lhs.text] = type; // source-order DFS → last-write-wins
          }
        }
        for (const child of n.children) collectIvars(child);
      };
      for (const child of (body ?? node).children) collectIvars(child);
      if (Object.keys(fields).length > 0) out[fq] = { ...(out[fq] ?? {}), ...fields };

      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return out;
}

/**
 * Infer `methodName → returnTypeName` from each method's BODY when no YARD
 * `@return` is present (cai0 a71lj body-inference). The return value of a Ruby
 * method is its LAST evaluated expression (implicit return) or an explicit
 * `return EXPR`; when that expression is a constructor / instance-returning
 * factory (`Widget.new`, `User.find(id)` — typed by {@link constInstanceType}),
 * the method's return type is that constant. Conservative: a conditional /
 * identifier / literal last expression records NOTHING (no guessing across
 * branches), mirroring the single-concrete-return discipline of
 * `collectYardReturnTypes`. Keyed by the bare method name (`def self.make` →
 * `make`), matching how the resolver reads `localCallBindings` short names.
 * YARD annotations win over body inference at the merge site (the walker).
 */
export function collectRubyBodyReturnTypes(root: AstNode): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    if (node.type !== "method" && node.type !== "singleton_method") return;
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!nameNode || !body) return;
    // Last value-producing statement of the body (skip rescue/ensure/else tails).
    const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
    let last = stmts[stmts.length - 1];
    if (!last) return;
    // Explicit `return EXPR` — unwrap to the returned expression.
    if (last.type === "return") {
      const arg = last.namedChildren[0];
      if (!arg) return;
      last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
      if (!last) return;
    }
    const type = constInstanceType(last);
    if (type) out[nameNode.text] = type;
  });
  return out;
}

/**
 * Collect `varName → calledMethodName` for assignments whose RHS is a method
 * call WITHOUT a directly-knowable type (`x = client.fetch`, `x = build_thing()`).
 * Pairs with the run-global `functionReturnTypes` channel so the resolver binds
 * `x.member` to `<fetch's return type>#member` (the universal return-type channel;
 * Go fills it via `collectGoLocalBindingsForChunk`, bd 6g9c). Constructor /
 * factory RHS (`Foo.new`, `Model.find`) is EXCLUDED — `constInstanceType` already
 * types those directly into `localBindings`, so recording them here too would be
 * a redundant weaker binding. The method name is the OUTERMOST call's method
 * (`x = a.b.c` → `c`), matching how `collectYardReturnTypes` keys return types.
 * Simple `Record` (last-write-wins), mirroring Go's `localCallBindings`.
 */
export function collectRubyLocalCallBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    if (node.type !== "assignment") return;
    const lhs = node.childForFieldName("left");
    const rhs = node.childForFieldName("right");
    if (lhs?.type !== "identifier" || !rhs) return;
    if (rhs.type !== "call" && rhs.type !== "method_call") return;
    if (constInstanceType(rhs) !== null) return; // directly typed → localBindings owns it
    const method = rhs.childForFieldName("method");
    if (method) out[lhs.text] = method.text; // last-write-wins
  });
  return out;
}

/**
 * Collect position-aware `varName → LocalBinding[]` bindings inside the given
 * line range. Each binding carries the 1-based source line where it is
 * established; a call site resolves against the most-recent binding at or before
 * its own line (`resolveLocalBindingType`), making `var.method()` resolution
 * flow-sensitive — reassignment to a different type is the correct answer per
 * call site, not a conflict.
 *
 * Sources scanned (pushed in source order so the position-aware lookup sees the
 * correct most-recent binding):
 *
 *   1. YARD `@param NAME [TYPE]` comments preceding `def NAME(...)` — bound at
 *      the `def` line (the parameter is in scope from method entry).
 *   2. Constructor / factory / finder assignments (`var = ClassName.new(...)`,
 *      `var = Model.find/find!/find_by/create/create!/build/first/last/take`).
 *   3. Copy propagation (`var = other_var`) — copies `other_var`'s most-recent
 *      type known at this line.
 *   4. Multiple assignment (`a, b = X.new, Y.new`) — paired positionally when
 *      arities match; splat / uneven arity is skipped.
 *   5. Param-default inference (`def f(x = User.new)`) — binds `x` for the
 *      method body at the `def` line.
 *
 * Sources deliberately NOT inferred:
 *   - Bare factory calls (`var = make_user()`) — no class name to attribute.
 *   - Chained Relation tails (`Model.where(...).first`) — `.where` returns
 *     a Relation, we'd need Relation-aware tracking. Bare `Model.first`
 *     IS inferred (the chain root is the Model class itself).
 *   - `var = CONST` constant-reference (var holds the class, not an instance) —
 *     deferred; needs a class-valued binding kind.
 *   - Block parameters and untyped params — need container/element typing (VTA).
 */
export function collectLocalBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
  yardByLine: Map<number, Record<string, string>>,
  associationTypes: Record<string, Record<string, string>> = {},
): Record<string, LocalBinding[]> {
  const out: Record<string, LocalBinding[]> = {};
  const push = (name: string, type: string, line: number): void => {
    (out[name] ??= []).push({ line, type });
  };

  // YARD `@param` bindings — attach to the def whose line falls in the chunk
  // range. `yardByLine` is keyed by the line of the `def` keyword; the param is
  // in scope from method entry, so the binding line is the `def` line.
  for (const [defLine, params] of yardByLine.entries()) {
    if (defLine < startLine || defLine > endLine) continue;
    for (const [name, type] of Object.entries(params)) push(name, type, defLine);
  }

  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;

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
          if (type) push(nameNode.text, type, line);
        }
      }
      return;
    }

    // Block-parameter element typing: `coll.each { |e| ... }` binds `e` to
    // coll's resolved (element) type. The block's parent is the iterator `call`
    // node. Only the FIRST positional param is the element (each_with_object /
    // reduce later params are accumulators — skipped). VTA is sound only when
    // the receiver already has a binding; unknown receiver → no binding.
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
        const elemType = resolveLocalBindingType(out, recvNode.text, line);
        const paramsNode = node.childForFieldName("parameters"); // block_parameters
        const firstParam = paramsNode?.namedChildren.find((p) => p.type === "identifier");
        if (elemType && firstParam) push(firstParam.text, elemType, line);
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
        const type =
          constInstanceType(value) ??
          (value.type === "identifier" ? resolveLocalBindingType(out, value.text, line) : undefined);
        if (type) push(target.text, type, line);
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
      push(varName, rhsConst, line);
      out[varName][out[varName].length - 1].valueKind = "class";
      return;
    }

    // Single assignment: class-constant instance call, else copy-propagation
    // (`var = other_var` copies other_var's most-recent type known at this line).
    const type =
      constInstanceType(rhs) ?? (rhs.type === "identifier" ? resolveLocalBindingType(out, rhs.text, line) : undefined);
    if (type) push(varName, type, line);
  });

  // Compound-receiver association-chain binding (B1). After single-var / ivar /
  // YARD bindings are known, type each PREFIX of a dotted chain receiver
  // (`event.user`, `event.user.agents`) left-to-right via the association map, so
  // the existing localType strategy — which keys on the FULL `call.receiver`
  // text — resolves the deepest call exactly. The root segment must already be
  // typed (Task 1-3 binding / YARD param / ivar); an unknown hop STOPS the walk
  // (honest fan-out). The cap is the chain's own segment count, and a cycle-guard
  // breaks a self-referential `has_many` so the walk never loops.
  bindCompoundReceiverChains(root, startLine, endLine, associationTypes, out, push);

  return out;
}

/** A dotted member chain whose root is a bare local — `event.user.agents`.
 *  Rejects constants, `::` scopes, `()` calls, `[]` index access, and `self`. */
const COMPOUND_CHAIN_RE = /^[a-z_][A-Za-z0-9_]*(?:\.[a-z_][A-Za-z0-9_]*)+$/;

/**
 * Walk every distinct dotted-chain call receiver in the chunk range and bind
 * each prefix to its association model type. For `event.user.agents` with
 * `event : Event`, `Event belongs_to :user` (→User), `User has_many :agents`
 * (→Agent): binds `event.user → User`, then `event.user.agents → Agent`. The
 * binding line is the receiver's own line so the position-aware lookup attaches
 * it correctly. Honours `class_name:` implicitly — the association map already
 * carries the rewritten model (`event.author → User`).
 */
function bindCompoundReceiverChains(
  root: AstNode,
  startLine: number,
  endLine: number,
  associationTypes: Record<string, Record<string, string>>,
  out: Record<string, LocalBinding[]>,
  push: (name: string, type: string, line: number) => void,
): void {
  // Distinct chain receiver texts (longest first so a deeper chain's prefixes
  // are all reachable) paired with the call line they appear on.
  const chains = new Map<string, number>();
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const receiver = node.childForFieldName("receiver");
    if (!receiver) return;
    const line = receiver.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    const { text } = receiver;
    if (!COMPOUND_CHAIN_RE.test(text)) return;
    if (!chains.has(text)) chains.set(text, line);
  });

  for (const [chain, line] of chains) {
    const segments = chain.split(".");
    const root0 = segments[0];
    if (!root0) continue;
    // Root segment type from an already-established binding at this line.
    const rootType = resolveLocalBindingType(out, root0, line);
    if (!rootType) continue; // untyped root → no walk (honest fan-out)
    let currentType: string = rootType;
    let prefix = root0;
    const seenTypes = new Set<string>([currentType]); // cycle-guard
    // Cap at the chain's own segment count (a self-referential has_many can't loop).
    for (let i = 1; i < segments.length; i++) {
      const accessor = segments[i];
      if (!accessor) break;
      const nextType: string | undefined = associationTypes[currentType]?.[accessor];
      if (!nextType) break; // unknown hop STOPS the walk
      prefix = `${prefix}.${accessor}`;
      // Bind the prefix only when not already typed (e.g. a single-var binding).
      if (resolveLocalBindingType(out, prefix, line) === undefined) push(prefix, nextType, line);
      if (seenTypes.has(nextType)) break; // self-referential chain → stop
      seenTypes.add(nextType);
      currentType = nextType;
    }
  }
}
