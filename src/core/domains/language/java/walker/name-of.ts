/**
 * Java `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`javaNameOf`) into the
 * native Java language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6, following the ruby + typescript + javascript
 * + python + go verticals). Behaviour-preserving extraction: the node-shape
 * detection and symbol emission are identical to the provider's former inline
 * function — a single self-contained `NamedSymbol | null` (no helper web, no
 * delegation).
 *
 * `method_declaration` routes through `methodKindFromClassify` (the kernel
 * helper that wraps `classifyMethod` in `infra/symbolid`) so the chunker and
 * codegraph agree on the separator for the same physical AST node
 * (`.claude/rules/symbolid-convention.md`): a `method_declaration` with a
 * `static` modifier is class-level (`.`), without one is instance-level (`#`).
 * `constructor_declaration` is always instance-bound (`Class#Class`) per the
 * convention — it initializes an instance. `class_declaration` /
 * `interface_declaration` / `enum_declaration` are scope containers
 * (`descendsInto: true`), composed with the `.` `scopeSeparator`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/method-kind.js";

export function javaNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "constructor_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: "instance" };
  }
  return null;
}
