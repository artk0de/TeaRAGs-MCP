/**
 * Go `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction. Delegates to the shared `goSymbolOf` (the single
 * source of the Go symbolId convention) so the chunker and codegraph stay in
 * lockstep by construction per `.claude/rules/symbolid-convention.md`.
 */
import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { goSymbolOf } from "../naming.js";

export function goNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  const sym = goSymbolOf(node);
  if (!sym) return null;
  return sym.instanceMethod
    ? { name: sym.name, descendsInto: false, methodKind: "instance" }
    : { name: sym.name, descendsInto: false };
}
