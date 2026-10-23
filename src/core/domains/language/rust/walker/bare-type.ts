import type { AstNode } from "../../../../contracts/types/ast.js";

/**
 * Reduce a Rust type node to its bare base type name, mirroring the Go
 * walker's `readBareTypeNode`. Strips references (`&Foo`, `&mut Foo` →
 * `Foo`) and unwraps generics (`Vec<Thing>` → `Vec`). Returns null for
 * shapes with no single named base (tuple/array/slice/fn-pointer types,
 * trait objects) so the binding is skipped rather than guessed.
 *
 * tree-sitter-rust shapes:
 *   - `type_identifier`         → `Foo`           (read text)
 *   - `reference_type`          → `&Foo` / `&mut Foo` (descend to inner type)
 *   - `generic_type`            → `Vec<Thing>`    (read `type` field base)
 *   - `scoped_type_identifier`  → `mod::Foo`      (bare last segment)
 */
export function readRustBareType(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier" || typeNode.type === "identifier") return typeNode.text;
  if (typeNode.type === "reference_type") {
    // `&Foo` / `&mut Foo` — the referent type is the only `type` field.
    const inner = typeNode.childForFieldName("type");
    return readRustBareType(inner);
  }
  if (typeNode.type === "generic_type") {
    // `Vec<Thing>`, `Box<dyn T>` — base type is the `type` field; could
    // itself be a `scoped_type_identifier`, so recurse to its bare name.
    const base = typeNode.childForFieldName("type");
    return readRustBareType(base);
  }
  if (typeNode.type === "scoped_type_identifier") {
    // `std::vec::Vec` / `module::Foo` — bare last segment.
    const name = typeNode.childForFieldName("name");
    return name?.type === "type_identifier" ? name.text : null;
  }
  return null;
}
