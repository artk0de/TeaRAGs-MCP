import type { AstNode } from "../../../../../contracts/types/ast.js";

/** Nodes that open a fresh local scope: a Ruby block shares its def's locals, these do not. */
const FRESH_LOCAL_SCOPES = new Set(["method", "singleton_method", "class", "module", "singleton_class"]);

/**
 * How many times each local name is BOUND inside one Ruby local scope — every
 * assignment target (`x = …`, `x ||= …`, `x += …`, each target of `a, b = …`),
 * every method / block / lambda parameter, `rescue … => x` and a `for x in`
 * target (bd tea-rags-mcp-0qaht.66). A name bound exactly once by `x = X.new`
 * holds an `X` wherever it is read; any second binding — a parameter, a
 * conditional reassignment, a block parameter shadowing it — may put something
 * else there, so the construction is no longer exact.
 *
 * Counted per scope, memoized by the scope's start offset: blocks are entered
 * (they read and write the def's locals), nested defs / classes / modules are
 * not. Over-counting is the safe direction — it only keeps the CHA cone.
 */
export class RubyLocalBindingSites {
  private readonly countsByScope = new Map<number, Map<string, number>>();

  /** Whether the assignment `node` is the only binding of `name` in its local scope. */
  isSoleBinding(node: AstNode, name: string): boolean {
    const scope = enclosingLocalScope(node);
    let counts = this.countsByScope.get(scope.startIndex);
    if (counts === undefined) {
      counts = countBindings(scope);
      this.countsByScope.set(scope.startIndex, counts);
    }
    return counts.get(name) === 1;
  }
}

function enclosingLocalScope(node: AstNode): AstNode {
  let scope = node;
  for (let p = node.parent; p !== null; p = p.parent) {
    scope = p;
    if (FRESH_LOCAL_SCOPES.has(p.type)) break;
  }
  return scope;
}

function countBindings(scope: AstNode): Map<string, number> {
  const counts = new Map<string, number>();
  const bind = (id: AstNode | null | undefined): void => {
    if (id?.type === "identifier") counts.set(id.text, (counts.get(id.text) ?? 0) + 1);
  };
  const bindTargets = (target: AstNode | null): void => {
    if (target === null) return;
    if (target.type === "identifier") bind(target);
    else if (target.type === "rest_assignment") bind(target.namedChildren.find((c) => c.type === "identifier"));
    else if (target.type === "left_assignment_list" || target.type === "destructured_left_assignment") {
      for (const child of target.namedChildren) bindTargets(child);
    }
  };
  const bindParameter = (param: AstNode): void => {
    if (param.type === "identifier") bind(param);
    else if (param.type === "destructured_parameter") for (const child of param.namedChildren) bindParameter(child);
    else bind(param.childForFieldName("name"));
  };
  const walk = (node: AstNode): void => {
    if (node !== scope && FRESH_LOCAL_SCOPES.has(node.type)) return;
    switch (node.type) {
      case "method_parameters":
      case "block_parameters":
      case "lambda_parameters":
        for (const child of node.namedChildren) bindParameter(child);
        break;
      case "assignment":
      case "operator_assignment":
        bindTargets(node.childForFieldName("left"));
        break;
      case "exception_variable":
        bind(node.namedChildren[0]);
        break;
      case "for":
        bindTargets(node.childForFieldName("pattern"));
        break;
      default:
        break;
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(scope);
  return counts;
}
