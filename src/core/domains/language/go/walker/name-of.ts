/**
 * Go `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`goNameOf` + its
 * companion `extractGoReceiverType`) into the native Go language provider per
 * the `domains/language` consolidation (spec §3; bd tea-rags-mcp-cen6,
 * following the ruby + typescript + javascript + python verticals).
 * Behaviour-preserving extraction: the node-shape detection and symbol
 * emission are identical to the provider's former inline functions.
 *
 * Go has no class/method nesting: `method_declaration` (always receiver-bound)
 * is an instance method emitted as `Receiver#Method` (the receiver type is
 * read via `extractGoReceiverType` so distinct receivers with the same method
 * short-name don't collide in the global symbol table); top-level
 * `function_declaration` and `type_declaration` get the bare `name` form. This
 * keeps the chunker and codegraph in lockstep per
 * `.claude/rules/symbolid-convention.md`.
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";

export function goNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "method_declaration") {
    // Go receiver-bound methods are instance methods. The receiver type
    // must be embedded in the emitted name as `Receiver#Method` —
    // otherwise methods with the same shortName from different receivers
    // (e.g. `(*Context).Query` and `(*Bind).Query`) collapse in the
    // global symbol table and fabricate false-positive cycles plus
    // mis-routed call edges. See .claude/rules/symbolid-convention.md.
    const id = node.childForFieldName("name");
    if (!id) return null;
    const receiverType = extractGoReceiverType(node);
    const composed = receiverType ? `${receiverType}#${id.text}` : id.text;
    return { name: composed, descendsInto: false, methodKind: "instance" };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "type_declaration") {
    // type Foo struct { ... } → emit Foo as a top-level symbol.
    const spec = node.children.find((c) => c.type === "type_spec");
    const id = spec?.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

/**
 * Extract the receiver type name from a Go `method_declaration` node,
 * stripping pointer (`*Receiver` → `Receiver`) and dropping any generic
 * type-parameter list. Returns null if the receiver cannot be parsed
 * (defensive — tree-sitter-go is error-tolerant).
 */
function extractGoReceiverType(method: Parser.SyntaxNode): string | null {
  const receiver = method.childForFieldName("receiver");
  if (!receiver) return null;
  const param = receiver.children.find((c) => c.type === "parameter_declaration");
  if (!param) return null;
  const typeNode = param.childForFieldName("type");
  if (!typeNode) return null;
  // `*Receiver` pointer types wrap the identifier.
  const ident =
    typeNode.type === "pointer_type" ? typeNode.children.find((c) => c.type === "type_identifier") : typeNode;
  if (!ident) return null;
  if (ident.type === "generic_type") {
    const base = ident.childForFieldName("type");
    return base?.text ?? null;
  }
  return ident.text;
}
