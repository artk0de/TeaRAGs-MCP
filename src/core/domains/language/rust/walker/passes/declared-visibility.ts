/**
 * Rust declared visibility (bd tea-rags-mcp-jwjyr.1), read by the kernel's
 * declared-visibility facet for every item `rustNameOf` names except an `impl`
 * block (no visibility of its own) and a `macro_rules!` (exported by attribute,
 * not by `pub`):
 *
 *   | item                                              | visibility |
 *   | ------------------------------------------------- | ---------- |
 *   | any `pub` form (`pub`, `pub(crate)`, `pub(super)`, `pub(in …)`) | public |
 *   | fn inside a `trait` body                          | public     |
 *   | fn inside an `impl Trait for Type` body           | public     |
 *   | anything else without `pub`                       | private    |
 *
 * "private" is Rust's module privacy — visible to the declaring module and its
 * descendants, which may live in other files. Trait items take no `pub` yet are
 * as visible as the trait; recording them private would let an access rule drop
 * every legal call through the trait.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { rustNameOf } from "../name-of.js";

const UNRECORDED_ITEM_TYPES: ReadonlySet<string> = new Set(["impl_item", "macro_definition"]);

/** A fn whose visibility is its trait's: declared in a trait, or implementing one. */
function isTraitMember(node: AstNode): boolean {
  if (node.type !== "function_item" || node.parent?.type !== "declaration_list") return false;
  const owner = node.parent.parent;
  if (owner?.type === "trait_item") return true;
  return owner?.type === "impl_item" && owner.childForFieldName("trait") !== null;
}

function rustVisibility(node: AstNode): DeclaredVisibility {
  if (node.children.some((c) => c.type === "visibility_modifier")) return "public";
  return isTraitMember(node) ? "public" : "private";
}

export const readRustDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  if (UNRECORDED_ITEM_TYPES.has(node.type)) return null;
  const named = rustNameOf(node);
  if (named === null) return null;
  return { name: named.name, visibility: rustVisibility(node) };
};

export const rustDeclaredVisibilityFacetPass: ExtractionFacetPass =
  declaredVisibilityFacetPass(readRustDeclaredVisibility);
