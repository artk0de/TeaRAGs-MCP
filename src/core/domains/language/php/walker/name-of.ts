/**
 * PHP `nameOf`. Classes, interfaces, traits and enums are scope containers.
 * Methods take `methodKind` from `classifyMethod` so the chunker and the
 * walker agree on `#` vs `.` — see `kernel.ts` for why a PHP `static_modifier`
 * still reads as instance. A `function_definition` is a leaf with no
 * `methodKind`.
 *
 * `namespace_definition` is intentionally unnamed. The chunker treats a
 * namespace as the outermost scope and drops that segment, so the class inside
 * it is `Greeter`, not `App\Demo\Greeter`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/index.js";

const SCOPE_CONTAINERS = new Set([
  "class_declaration",
  "interface_declaration",
  "trait_declaration",
  "enum_declaration",
]);

export function phpNameOf(node: AstNode): NamedSymbol | null {
  if (SCOPE_CONTAINERS.has(node.type)) {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}
