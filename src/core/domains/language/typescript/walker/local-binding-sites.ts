import type { AstNode } from "../../../../contracts/types/ast.js";

/** Nodes that open a function scope — where a `let` / `var` / parameter name lives. */
const FUNCTION_SCOPES = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
  "class_static_block",
]);

/** Pattern nodes whose identifiers a destructuring binds. */
const PATTERN_NODES = new Set([
  "object_pattern",
  "array_pattern",
  "pair_pattern",
  "rest_pattern",
  "assignment_pattern",
  "object_assignment_pattern",
]);

/**
 * How many times each local name is BOUND inside the function enclosing a
 * declaration — every declarator, assignment / compound assignment / `++`
 * target, parameter, `for (x of …)` target and `catch (x)`, destructuring
 * included (bd tea-rags-mcp-0qaht.66). A name bound exactly once, by
 * `const x = new X()`, holds an `X` wherever it is read; a second binding may
 * put anything there.
 *
 * Nested functions are COUNTED, not skipped: a closure may reassign the outer
 * `let`, and a nested namesake only over-counts — the safe direction, which
 * keeps the CHA cone. Memoized per scope by its start offset.
 */
export class TypescriptLocalBindingSites {
  private readonly countsByScope = new Map<number, Map<string, number>>();

  /** Whether `name`, declared at `node`, is bound exactly once in its function scope. */
  isSoleBinding(node: AstNode, name: string): boolean {
    const scope = enclosingFunctionScope(node);
    let counts = this.countsByScope.get(scope.startIndex);
    if (counts === undefined) {
      counts = countBindings(scope);
      this.countsByScope.set(scope.startIndex, counts);
    }
    return counts.get(name) === 1;
  }
}

function enclosingFunctionScope(node: AstNode): AstNode {
  let scope = node;
  for (let p = node.parent; p !== null; p = p.parent) {
    scope = p;
    if (FUNCTION_SCOPES.has(p.type)) break;
  }
  return scope;
}

function countBindings(scope: AstNode): Map<string, number> {
  const counts = new Map<string, number>();
  const bind = (target: AstNode | null): void => {
    if (target === null) return;
    if (target.type === "identifier" || target.type === "shorthand_property_identifier_pattern") {
      counts.set(target.text, (counts.get(target.text) ?? 0) + 1);
    } else if (PATTERN_NODES.has(target.type)) {
      for (const child of target.namedChildren) bind(child);
    }
  };
  const walk = (node: AstNode): void => {
    switch (node.type) {
      case "variable_declarator":
        bind(node.childForFieldName("name"));
        break;
      case "assignment_expression":
      case "augmented_assignment_expression":
        bind(node.childForFieldName("left"));
        break;
      case "update_expression":
        // The operand positionally: `x++` / `--x` hold one named child. Read by
        // field, `argument` is a name the grammar drops on `literal_type` under
        // materialization (the field-loss inventory pins the pairs).
        bind(node.namedChildren[0] ?? null);
        break;
      case "required_parameter":
      case "optional_parameter":
        bind(node.childForFieldName("pattern"));
        break;
      case "arrow_function":
        bind(node.childForFieldName("parameter"));
        break;
      case "for_in_statement":
        bind(node.childForFieldName("left"));
        break;
      case "catch_clause":
        bind(node.childForFieldName("parameter"));
        break;
      default:
        break;
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(scope);
  return counts;
}
