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

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod, constObjectNamespaceName } from "../../../../infra/symbolid/index.js";

function methodKindFromClassify(node: AstNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

export function tsNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "method_definition") {
    const id = node.childForFieldName("name");
    // bd tea-rags-mcp-2jhwk — a `method_definition` sitting directly in an
    // OBJECT LITERAL is a namespace member, not a class method: it is invoked
    // as `X.member()` on the object itself and there is no instance to bind.
    // `classifyMethod` declines to classify those, leaving `methodKind` unset so
    // the language `scopeSeparator` composes the `Outer.Nested` namespace form
    // the convention reserves for exactly this case
    // (`.claude/rules/symbolid-convention.md`).
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
  // bd tea-rags-mcp-2jhwk — const-object NAMESPACE:
  //
  //   export const FileLevelGrouper = { group(...) { … } };
  //
  // A widely-used alternative to a static-only class, and previously invisible:
  // the members landed as bare top-level symbols (fq `group`, scope `[]`) and
  // the receiver name had no symbol at all. Two consequences, both measured by
  // `scripts/ts-codegraph-typechecker-oracle.ts` over this repo's own `src`:
  // `FileLevelGrouper.group()` could not be pinned (the barrel re-export hop in
  // `TSNamedImportSymbolResolutionStrategy` gates on the receiver being in the
  // symbol table, so those calls held a file-only edge on the BARREL), and
  // three different files each declared a symbol called plain `group`, so
  // `find_symbol` / `get_callers` could not tell them apart.
  //
  // Naming the declarator with `descendsInto: true` fixes both at once: the
  // receiver becomes lookup-able and its members compose as `X.member`.
  //
  // The shape gate (object literal carrying at least one `method_definition`,
  // seen through `as const` / `satisfies` / parentheses) lives in
  // `infra/symbolid/const-object-namespace.ts` — the CHUNKER asks the same
  // question about the same node and the two must not drift apart
  // (bd tea-rags-mcp-62hzr).
  const namespaceName = constObjectNamespaceName(node);
  if (namespaceName) return { name: namespaceName, descendsInto: true };
  return null;
}
