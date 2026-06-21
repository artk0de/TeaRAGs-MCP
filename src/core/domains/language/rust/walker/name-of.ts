/**
 * Rust `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`rustNameOf` + its
 * `stripRustGenerics` helper) into the native Rust language provider per the
 * `domains/language` consolidation (spec §3; bd tea-rags-mcp-cen6, the seventh
 * vertical after ruby + typescript + javascript + python + go + java).
 * Behaviour-preserving extraction: the node-shape detection and symbol emission
 * are identical to the provider's former inline function — a single
 * self-contained `NamedSymbol | null` (the only dependency, `stripRustGenerics`,
 * travels with it).
 *
 * `function_item` routes through `methodKindFromClassify` (the kernel helper
 * that wraps `classifyMethod` in `infra/symbolid`) so the chunker and codegraph
 * agree on the separator for the same physical AST node
 * (`.claude/rules/symbolid-convention.md`): a `function_item` WITH a
 * `self`/`&self` parameter is instance-level (`#`), one WITHOUT is an associated
 * function (`.`). `struct_item` / `enum_item` / `trait_item` / `mod_item` are
 * scope containers (`descendsInto: true`), composed with the `::`
 * `scopeSeparator`. `impl_item` attributes its methods to the implementing
 * TYPE (the `type` field, generics stripped), never the trait.
 * `macro_definition` (`macro_rules! foo`) emits a leaf symbol so
 * `find_symbol("foo")` resolves the macro definition.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/method-kind.js";

export function rustNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "function_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "struct_item" || node.type === "enum_item" || node.type === "trait_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "mod_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "impl_item") {
    // bd tea-rags-mcp-2hbd — `impl Trait for Type` MUST attribute methods
    // to the implementing TYPE, never the trait. tree-sitter-rust names
    // the implementing type as the `type` field in BOTH shapes:
    //   `impl Foo { ... }`             → type=Foo
    //   `impl Trait for Foo { ... }`   → type=Foo, trait=Trait
    // The trait child is intentionally ignored here as a class scope —
    // tracking it as a separate symbol is a future-spec concern.
    const ty = node.childForFieldName("type");
    if (!ty) return null;
    // bd tea-rags-mcp-h82m — strip generic params + lifetimes so
    // `impl<'s> Worker<'s>` → scope name "Worker", not "Worker<'s>".
    // `generic_type` is the tree-sitter-rust node wrapping a base type
    // identifier with `<...>`; pull the inner `type` field. For bare
    // `type_identifier` (no generics) the text is already clean.
    const name = stripRustGenerics(ty);
    if (!name) return null;
    return { name, descendsInto: true };
  }
  if (node.type === "macro_definition") {
    // bd tea-rags-mcp-jyzb — `macro_rules! foo { ... }` declares a macro.
    // tree-sitter-rust shapes the node as `macro_definition` with a
    // `name` field carrying the identifier. Emitting a symbol here lets
    // find_symbol("foo") resolve the macro definition.
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

/**
 * Strip generic parameters and lifetimes from a Rust impl type node:
 *   `Worker<'s>`        → "Worker"
 *   `Container<T>`      → "Container"
 *   `Container<T: Clone>` → "Container"
 *   `Foo`               → "Foo"
 * Returns null for unrecognized shapes.
 */
function stripRustGenerics(typeNode: AstNode): string | null {
  if (typeNode.type === "generic_type") {
    const base = typeNode.childForFieldName("type");
    if (base) return base.text;
    // Fallback for grammar drift: take the first type_identifier child.
    const ident = typeNode.children.find((c) => c.type === "type_identifier");
    return ident?.text ?? null;
  }
  // `type_identifier`, `scoped_type_identifier`, or any leaf — use raw
  // text but strip any trailing `<...>` defensively (covers grammars
  // that flatten generic_type into the parent).
  const raw = typeNode.text;
  const lt = raw.indexOf("<");
  return (lt === -1 ? raw : raw.slice(0, lt)).trim() || null;
}
