/**
 * Go `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction. Delegates to the shared `goSymbolOf` (the single
 * source of the Go symbolId convention) so the chunker and codegraph stay in
 * lockstep by construction per `.claude/rules/symbolid-convention.md`.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { goSymbolOf, goTypeSpecSymbolOf } from "../naming.js";

export function goNameOf(node: AstNode): NamedSymbol | null {
  // Grouped `type ( A ...; B ... )` (bd tea-rags-mcp-fov8f): the declaration
  // node emits nothing — every `type_spec` / `type_alias` child answers for
  // itself, on its own line range, through the same per-spec reader the single
  // form reads its lone spec with (`goSymbolOf`'s type_declaration clause). The
  // chunker classifier consumes `goSymbolOf` on the same node and is untouched,
  // so the two sides of the symbolId convention stay in lockstep.
  if (node.type === "type_spec" || node.type === "type_alias") {
    const spec = goTypeSpecSymbolOf(node);
    return spec ? { name: spec.name, descendsInto: false } : null;
  }
  if (node.type === "type_declaration") return null;
  const sym = goSymbolOf(node);
  if (!sym) return null;
  return sym.instanceMethod
    ? { name: sym.name, descendsInto: false, methodKind: "instance" }
    : { name: sym.name, descendsInto: false };
}
