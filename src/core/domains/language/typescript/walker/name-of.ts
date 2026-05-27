/**
 * TypeScript `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`tsNameOf` +
 * `methodKindFromClassify`) into the native TypeScript language provider per the
 * `domains/language` consolidation (spec §3; bd tea-rags-mcp-cen6).
 * Behaviour-preserving extraction: the node-shape detection and symbol emission
 * are identical to the provider's former inline function.
 *
 * `method_definition` routes through `classifyMethod` (in `infra/symbolid`) so
 * the chunker and codegraph agree on the separator (`#` instance / `.` static)
 * for the same physical AST node (`.claude/rules/symbolid-convention.md`).
 *
 * NOTE: the JavaScript-only shapes (CommonJS `obj.method = fn`,
 * `Foo.prototype.bar`, `Object.defineProperty` getters, the HTTP-verb forEach
 * dispatch, etc.) are NOT here — `jsNameOf` in `provider.ts` wraps the codegraph
 * config's TS `nameOf` and adds those. JavaScript is still served by the legacy
 * adapter, so its `jsNameOf` keeps a local `tsNameOf` to delegate to. This
 * native copy serves the TypeScript provider's `walker.nameOf` capability.
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod } from "../../../../infra/symbolid/index.js";

function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

export function tsNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "method_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    // bd tea-rags-mcp-vw1u — synthesize Class#constructor when no explicit
    // constructor is declared in the body. TS/JS classes without
    // `constructor() {}` still have an implicit constructor that
    // `new Class()` / `super()` resolve to; the synthetic keeps
    // resolver lookups consistent.
    //
    // bd tea-rags-mcp-q3o2 — tree-sitter-typescript emits
    // `abstract_class_declaration` (NOT `class_declaration`) for
    // `abstract class X {}`. Without this branch the walker skipped
    // abstract bases entirely: their members never reached cg_symbols,
    // children's `super(...)` calls resolved against an empty parent
    // entry, and `get_callers(AbstractBase#constructor)` returned `[]`
    // even though concrete subclasses called it. Same `childForFieldName`
    // shape, same class_body — the only difference is the keyword.
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true, syntheticConstructorIfMissing: true };
  }
  return null;
}
