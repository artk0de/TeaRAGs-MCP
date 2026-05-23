/**
 * Go symbol resolver for chunker `chunkSingleNode`.
 *
 * The chunker writes the Qdrant payload `symbolId` for each AST node it
 * chunks. The codegraph provider's `goNameOf` writes
 * `cg_symbols.symbol_id` for the SAME physical AST node. Both must
 * agree per `.claude/rules/symbolid-convention.md` — mismatches break
 * `find_symbol` / `get_callers` lookups (silent ghost rows).
 *
 * Shapes covered:
 *
 *   1. `method_declaration` — receiver-bound, instance form
 *      `Receiver#Method`. Pointer-receiver `*Receiver` strips to bare
 *      `Receiver`. Generic-receiver `Receiver[T]` strips type params.
 *   2. `type_declaration` — `type Foo struct {...}`, `type Foo interface
 *      {...}`, `type Foo func(...)`, `type Foo []Bar`, `type Foo
 *      map[K]V`. The identifier lives on the `type_spec` child whose
 *      `name` field carries the type identifier. Default
 *      `extractName(type_declaration)` returns undefined because
 *      `type_declaration` has no `name` field directly — handle here.
 *
 * Top-level `function_declaration` falls through to the default
 * `extractName` path because its `name` field is on the node itself.
 *
 * bd tea-rags-mcp-n7x5, bd tea-rags-mcp-j2b7
 */
import type Parser from "tree-sitter";

import { INSTANCE_METHOD_SEPARATOR } from "../../../../../../infra/symbolid/index.js";

export interface GoSymbol {
  name: string;
  symbolId: string;
}

/**
 * Resolve `name` + `symbolId` for Go method/type nodes. Returns null for
 * any other node — caller falls back to the default name extraction.
 */
export function extractGoSymbol(node: Parser.SyntaxNode): GoSymbol | null {
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    const receiver = extractGoReceiverType(node);
    const methodName = id.text;
    if (!receiver) {
      // Defensive: receiver-less method shouldn't happen in valid Go,
      // but if the parser is mid-edit, fall back to bare method name
      // so we don't lose the chunk symbolId entirely.
      return { name: methodName, symbolId: methodName };
    }
    const composed = `${receiver}${INSTANCE_METHOD_SEPARATOR}${methodName}`;
    return { name: composed, symbolId: composed };
  }
  if (node.type === "type_declaration") {
    // type_declaration > type_spec > name: type_identifier
    // Covers struct / interface / function-type alias / map alias / etc.
    const spec = node.children.find((c) => c.type === "type_spec" || c.type === "type_alias");
    if (!spec) return null;
    const id = spec.childForFieldName("name");
    if (!id) return null;
    const name = id.text;
    return { name, symbolId: name };
  }
  return null;
}

/**
 * Extract the receiver type name from a Go `method_declaration` node,
 * stripping pointer (`*Receiver` → `Receiver`) and dropping any generic
 * type-parameter list. Mirrors the codegraph provider's
 * `extractGoReceiverType` exactly — duplicated locally to avoid an
 * ingest→trajectory import (domain-boundaries rule).
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
