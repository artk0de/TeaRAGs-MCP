import type { AstNode } from "../../../../contracts/types/ast.js";
import { isInlineTestNode } from "../inline-tests.js";

/** Item types the engine already keeps out of the module remainder as imports. */
const IMPORT_ITEM_TYPES = new Set(["use_declaration", "extern_crate_declaration"]);

const COMMENT_NODE_TYPES = new Set(["line_comment", "block_comment"]);

/**
 * A body-less test-only module declaration (`#[cfg(test)] mod testutil;`): it
 * only brings another file in, and only in the test build. A body-less
 * production `mod parser;` is not one and stays in the remainder.
 *
 * `isModuleImport` receives no source; Rust's `isInlineTestNode` reads the
 * attributes from the nodes' own text, so passing `""` is safe.
 */
function isTestOnlyModDeclaration(node: AstNode): boolean {
  if (node.type !== "mod_item") return false;
  if (node.namedChildren.some((child) => child.type === "declaration_list")) return false;
  return isInlineTestNode(node, "");
}

/** The item an outer attribute is attached to: the next named sibling past further attributes and comments. */
function attachedItem(attribute: AstNode): AstNode | null {
  const siblings = attribute.parent?.namedChildren ?? [];
  for (let index = siblings.indexOf(attribute) + 1; index > 0 && index < siblings.length; index++) {
    const sibling = siblings[index];
    if (sibling.type !== "attribute_item" && !COMMENT_NODE_TYPES.has(sibling.type)) return sibling;
  }
  return null;
}

/**
 * `LanguageChunkerHooks.isModuleImport` for Rust. Tree-sitter keeps an outer
 * attribute as a sibling of its item, so the engine excluding a `use` /
 * `extern crate` as an import left its `#[cfg(test)]` row behind in the module
 * remainder. True for an `attribute_item` attached to an import or to a
 * body-less test-only `mod x;`, and for that `mod x;` itself.
 */
export function isRustModuleImport(node: AstNode): boolean {
  if (node.type === "attribute_item") {
    const item = attachedItem(node);
    return item !== null && (IMPORT_ITEM_TYPES.has(item.type) || isTestOnlyModDeclaration(item));
  }
  return isTestOnlyModDeclaration(node);
}
