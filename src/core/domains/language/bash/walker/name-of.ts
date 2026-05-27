/**
 * Bash `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`bashNameOf`) into the
 * native Bash language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6, the eighth and LAST source-language vertical
 * after ruby + typescript + javascript + python + go + java + rust).
 * Behaviour-preserving extraction: the node-shape detection and symbol emission
 * are identical to the provider's former inline function — a single
 * self-contained `NamedSymbol | null` with NO dependencies.
 *
 * Bash has NO class concept — only top-level `function_definition`s — so there
 * is no `methodKind` (instance vs static) to classify and no scope-container
 * descent: every named function is a leaf symbol (`descendsInto: false`). This
 * is why `bashNameOf` does NOT route through `methodKindFromClassify` (unlike
 * the rust/go/java walkers) — there is no method to classify.
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";

export function bashNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}
