/**
 * The scoped descent both Python type sources share (E2 seam 2, bd
 * tea-rags-mcp-9fgdi).
 *
 * A `TypeFact` coordinate is (class chain, method name, name, line), and the
 * monolith's flat `walk(root, cb)` supplies none of the first three. This walks
 * the tree once carrying a class chain and a function stack, and hands each
 * `def` and each annotated assignment the scope it actually sits in. Both
 * sources call it, which is what guarantees the `annotations` and `docstring`
 * facts for one parameter land on the SAME coordinate — `coordinateKey`
 * includes `line` (`kernel/type-fact-store.ts:80`), so a disagreement there
 * would keep both facts instead of letting the ranked one win.
 *
 * Classes contribute to the chain; functions do not. A nested `def` therefore
 * reports its parent's class chain and its own name, which matches what
 * `pyNameOf` + the chunker compose for that node.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBareTypeName } from "./python-type-annotation.js";

export interface PythonDefSite {
  /** The `function_definition`, decorators unwrapped. */
  readonly node: AstNode;
  /** Bare last segments: "classmethod", "property". */
  readonly decorators: readonly string[];
  /** Enclosing classes, short names, outermost first. */
  readonly classChain: readonly string[];
  readonly name: string;
  /** 1-based line of the `def`. */
  readonly line: number;
}

export interface PythonAnnotatedAssignmentSite {
  /** The `assignment` node, `type` field present. */
  readonly node: AstNode;
  readonly classChain: readonly string[];
  /** Undefined at class-body / module level. */
  readonly methodName: string | undefined;
  readonly line: number;
}

/**
 * One `for` binding site. Both spellings arrive here: a `for_statement` and a
 * comprehension's `for_in_clause`, which bind their target identically and
 * differ only in that a clause carries no block of its own. `methodName` is the
 * enclosing def — `undefined` at module level, where a comprehension variable
 * has no coordinate a `local` fact could be filed under.
 */
export interface PythonForStatementSite {
  /** The `for_statement` / `for_in_clause`, with its `left` and `right` fields. */
  readonly node: AstNode;
  readonly classChain: readonly string[];
  readonly methodName: string | undefined;
  /** 1-based line of the `for` keyword. */
  readonly line: number;
}

export interface PythonScopeVisitor {
  onDef?: (site: PythonDefSite) => void;
  onAnnotatedAssignment?: (site: PythonAnnotatedAssignmentSite) => void;
  onForStatement?: (site: PythonForStatementSite) => void;
}

/** `@classmethod` / `@staticmethod` mark a def whose structured-return key joins with `.`. */
export function isPythonClassFormDef(decorators: readonly string[]): boolean {
  return decorators.includes("classmethod") || decorators.includes("staticmethod");
}

/** Unwrap tree-sitter-python's `type` wrapper to the annotation expression itself. */
export function pythonAnnotationExpression(typeField: AstNode): AstNode {
  return typeField.type === "type" ? (typeField.namedChild(0) ?? typeField) : typeField;
}

function decoratorNames(decorated: AstNode): string[] {
  const out: string[] = [];
  for (const child of decorated.namedChildren) {
    if (child.type !== "decorator") continue;
    const expr = child.namedChild(0);
    if (expr === null) continue;
    // `@app.route("/x")` — the decorator's identity is the CALLEE, not the call.
    const target = expr.type === "call" ? expr.childForFieldName("function") : expr;
    if (target !== null) out.push(pythonBareTypeName(target.text));
  }
  return out;
}

export function walkPythonScopes(root: AstNode, visitor: PythonScopeVisitor): void {
  const classChain: string[] = [];
  const fnStack: string[] = [];

  const descendBody = (node: AstNode): void => {
    const body = node.childForFieldName("body");
    if (body === null) return;
    for (const child of body.namedChildren) descend(child);
  };

  const visitDefinition = (node: AstNode, decorators: readonly string[]): void => {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return;
    if (node.type === "class_definition") {
      classChain.push(name);
      descendBody(node);
      classChain.pop();
      return;
    }
    visitor.onDef?.({ node, decorators, name, classChain: [...classChain], line: node.startPosition.row + 1 });
    fnStack.push(name);
    descendBody(node);
    fnStack.pop();
  };

  const descend = (node: AstNode): void => {
    if (node.type === "decorated_definition") {
      const inner = node.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition");
      if (inner !== undefined) visitDefinition(inner, decoratorNames(node));
      return;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      visitDefinition(node, []);
      return;
    }
    if (node.type === "assignment" && node.childForFieldName("type") !== null) {
      visitor.onAnnotatedAssignment?.({
        node,
        classChain: [...classChain],
        methodName: fnStack[fnStack.length - 1],
        line: node.startPosition.row + 1,
      });
      return;
    }
    // No early return: a `for` body holds the defs and annotated assignments
    // the other visitors still need, and a comprehension clause sits inside an
    // expression whose siblings do too.
    if (node.type === "for_statement" || node.type === "for_in_clause") {
      visitor.onForStatement?.({
        node,
        classChain: [...classChain],
        methodName: fnStack[fnStack.length - 1],
        line: node.startPosition.row + 1,
      });
    }
    for (const child of node.namedChildren) descend(child);
  };

  for (const child of root.namedChildren) descend(child);
}
