import type { AstNode } from "../../../../contracts/types/ast.js";
import { resolveLocalBindingType, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import { readScopeResolution, walk } from "./ast-utils.js";
import { constInstanceType } from "./type-sources/ast-inference.js";

export { collectYardParamTypes, collectYardReturnTypes, YARD_CONST } from "./type-sources/yard.js";
export {
  INSTANCE_RETURNING_METHODS,
  RELATION_RETURNING_METHODS,
  RUBY_BLOCK_ITERATOR_METHODS,
} from "./type-sources/ast-inference.js";

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
 * carries the rewritten model (`event.author → User`). Exported for use by the
 * walker's store-path rewire (Task 0.5) as a post-store association-chain pass.
 */
export function bindCompoundReceiverChains(
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
