/**
 * Rust test-scope filter.
 *
 * Rust tests are attributes on ordinary syntax nodes, not a callable DSL. The
 * filter therefore keeps Rust modules and functions available to the scope
 * hook; the scope reader decides which functions are examples and which are
 * setup/context. This preserves the generic AST path for production modules.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";

const RUST_TEST_ATTRIBUTES = new Set(["test", "rstest", "test_case"]);

/**
 * Return the Rust attributes immediately preceding a node. Tree-sitter keeps
 * `attribute_item` as a sibling of the item, so it is not available through
 * the item's `children` and must be read from source rows.
 */
export function leadingRustAttributes(node: AstNode, code: string): string[] {
  const lines = code.split("\n");
  const attributes: string[] = [];
  for (let row = node.startPosition.row - 1; row >= 0; row--) {
    const text = lines[row]?.trim() ?? "";
    if (text.startsWith("#[") && text.endsWith("]")) {
      attributes.unshift(text);
      continue;
    }
    if (text.length === 0) continue;
    break;
  }
  return attributes;
}

function attributeBody(attribute: string): string {
  return attribute.slice(2, -1).trim();
}

function attributeName(attribute: string): string {
  const body = attributeBody(attribute);
  const path = body.split("(", 1)[0].trim();
  return path.split("::").at(-1) ?? path;
}

/** True for `#[test]`, `#[tokio::test]`, `#[rstest]`, and `#[test_case(...)]`. */
export function isRustTestFunction(node: AstNode, code: string): boolean {
  if (node.type !== "function_item") return false;
  return leadingRustAttributes(node, code).some((attribute) => RUST_TEST_ATTRIBUTES.has(attributeName(attribute)));
}

/** True for an explicit `#[cfg(test)]` module. */
export function hasCfgTestAttribute(node: AstNode, code: string): boolean {
  return leadingRustAttributes(node, code).some((attribute) => /^cfg\s*\(\s*test\s*\)$/.test(attributeBody(attribute)));
}

/**
 * A module is a test scope when it is explicitly `#[cfg(test)]` or contains a
 * recognized test function/module. The latter admits nested helper modules
 * without requiring every nested module to repeat `#[cfg(test)]`.
 */
export function isRustTestModule(node: AstNode, code: string): boolean {
  if (node.type !== "mod_item") return false;
  if (hasCfgTestAttribute(node, code)) return true;
  const declarationList = node.namedChildren.find((child) => child.type === "declaration_list");
  const declarations = declarationList?.namedChildren ?? [];
  return declarations.some((child) => {
    if (child.type === "function_item") return isRustTestFunction(child, code);
    return child.type === "mod_item" && isRustTestModule(child, code);
  });
}

export const rustTestDslFilterHook: ChunkingHook = {
  name: "rust-test-dsl-filter",

  filterNode(node: AstNode): boolean | undefined {
    // Keep every module/function on the generic candidate path. The process
    // hook below claims only recognized test modules; production output keeps
    // the existing generic shaping and parent identity.
    if (node.type === "mod_item" || node.type === "function_item") return true;
    return undefined;
  },

  process(_ctx: HookContext): void {
    // Filtering is the only responsibility of this hook.
  },
};
