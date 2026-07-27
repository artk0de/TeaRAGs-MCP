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
 * Visit every `class` / `module` declaration with the scope stack that encloses
 * it, so per-class collectors agree on ONE fully-qualified key. `fq` is the
 * declaration's own lexical FQ (`Outer::Inner`, compact `class A::B` kept
 * verbatim); `scope` is the stack ABOVE it. Recursion descends through the
 * declaration's body, so a nested class is visited with its parent appended —
 * matching `collectRubyClassAncestors` and `ctx.callerScope.join("::")`.
 *
 * An anonymous declaration (`class << self`, no `name` field) is transparent:
 * the walk passes through it without pushing a scope segment.
 */
export function forEachClassScope(
  root: AstNode,
  visit: (classNode: AstNode, fq: string, scope: readonly string[]) => void,
): void {
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      visit(node, lexicalScopeFqName(scope, localName), scope);
      const body = node.childForFieldName("body");
      for (const child of (body ?? node).children) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
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
