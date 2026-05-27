/**
 * Python `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`pyNameOf`) into the
 * native Python language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6, following the ruby + typescript + javascript
 * verticals). Behaviour-preserving extraction: the node-shape detection and
 * symbol emission are identical to the provider's former inline function — a
 * single self-contained `NamedSymbol | null` (no helper web, no delegation).
 *
 * `function_definition` / `class_definition` route through `classifyMethod`
 * (in `infra/symbolid`) so the chunker and codegraph agree on the separator for
 * the same physical AST node (`.claude/rules/symbolid-convention.md`): a method
 * decorated with `@classmethod` / `@staticmethod` is class-level (`.`), an
 * undecorated method inside a class is instance-level (`#`).
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod } from "../../../../infra/symbolid/index.js";

function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

export function pyNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "class_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}
