/**
 * Rust declared visibility (bd tea-rags-mcp-jwjyr.1), read by the kernel's
 * declared-visibility facet for every item `rustNameOf` names except an `impl`
 * block (no visibility of its own):
 *
 *   | item                                              | visibility |
 *   | ------------------------------------------------- | ---------- |
 *   | any `pub` form (`pub`, `pub(crate)`, `pub(super)`, `pub(in …)`) | public |
 *   | fn inside a `trait` body                          | public     |
 *   | fn inside an `impl Trait for Type` body           | public     |
 *   | `macro_rules!` under `#[macro_export]`            | public     |
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

const UNRECORDED_ITEM_TYPES: ReadonlySet<string> = new Set(["impl_item"]);

/** Nodes that may sit between an item and its outer attributes: further attributes and comments. */
const RUST_ATTRIBUTE_RUN_TYPES: ReadonlySet<string> = new Set(["attribute_item", "line_comment", "block_comment"]);

const RUST_MACRO_EXPORT_ATTRIBUTE = /^#\[\s*macro_export\b/;

/**
 * The texts of an item's outer attributes, nearest first: the run of
 * `attribute_item` siblings (comments may interleave) directly above it.
 */
export function rustOuterAttributeTexts(node: AstNode): string[] {
  const texts: string[] = [];
  for (let sibling = node.previousNamedSibling; sibling !== null; sibling = sibling.previousNamedSibling) {
    if (!RUST_ATTRIBUTE_RUN_TYPES.has(sibling.type)) break;
    if (sibling.type === "attribute_item") texts.push(sibling.text);
  }
  return texts;
}

/**
 * A `macro_rules!` is exported by attribute, not by `pub` (bd
 * tea-rags-mcp-s3i8m.4): `#[macro_export]` (any argument form) among its outer
 * attributes puts it at the crate root for every dependent crate; without it
 * the macro is textually scoped to its own crate.
 */
function rustMacroIsExported(node: AstNode): boolean {
  return rustOuterAttributeTexts(node).some((text) => RUST_MACRO_EXPORT_ATTRIBUTE.test(text));
}

/** A fn whose visibility is its trait's: declared in a trait, or implementing one. */
function isTraitMember(node: AstNode): boolean {
  if (
    (node.type !== "function_item" && node.type !== "function_signature_item") ||
    node.parent?.type !== "declaration_list"
  ) {
    return false;
  }
  const owner = node.parent.parent;
  if (owner?.type === "trait_item") return true;
  return owner?.type === "impl_item" && owner.childForFieldName("trait") !== null;
}

function rustVisibility(node: AstNode): DeclaredVisibility {
  if (node.type === "macro_definition") return rustMacroIsExported(node) ? "public" : "private";
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
