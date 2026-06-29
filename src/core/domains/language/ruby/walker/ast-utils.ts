import type { AstNode } from "../../../../contracts/types/ast.js";

/**
 * Lexical fully-qualified name: prefix `localName` with the enclosing class/module
 * scope stack, matching the form `collectRubyInheritanceEdges` writes into
 * `sourceFqName` (bd tea-rags-mcp-pffv). The SINGLE source of truth for ruby
 * lexical-fq so the cone hierarchy keys and the RTA instantiation keys cannot drift.
 */
export function lexicalScopeFqName(scope: readonly string[], localName: string): string {
  return scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
}

/** Pre-order DFS over the tree-sitter node tree, invoking `visit` on each node. */
export function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Read a `scope_resolution` node into its fully-qualified constant string.
 * `scope_resolution` has fields `scope` (left) and `name` (right); recurse on
 * `scope` when it is another `scope_resolution`, otherwise take its constant
 * text. `Acme::Auth::Login` → `"Acme::Auth::Login"`.
 */
export function readScopeResolution(node: AstNode): string {
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? readScopeResolution(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}
