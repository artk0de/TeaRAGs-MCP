import type Parser from "tree-sitter";

/** Pre-order DFS over the tree-sitter node tree, invoking `visit` on each node. */
export function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Read a `scope_resolution` node into its fully-qualified constant string.
 * `scope_resolution` has fields `scope` (left) and `name` (right); recurse on
 * `scope` when it is another `scope_resolution`, otherwise take its constant
 * text. `Acme::Auth::Login` → `"Acme::Auth::Login"`.
 */
export function readScopeResolution(node: Parser.SyntaxNode): string {
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? readScopeResolution(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}
