/**
 * Rust test-scope filter.
 *
 * Rust tests are attributes on ordinary syntax nodes, not a callable DSL. The
 * filter therefore keeps Rust modules and functions available to the scope
 * hook; the scope reader decides — from the attribute AST, see
 * `../inline-tests.ts` — which items are test-only, which functions are
 * examples and which are setup/context. This preserves the generic AST path
 * for production modules.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";
import { isInlineTestNode } from "../inline-tests.js";

/** Declarations chunkable only as a test-only item outside a test module (`rustChunkerHooks.chunkableTypes`). */
const TEST_ONLY_DECLARATION_TYPES = new Set(["const_item", "static_item", "type_item", "union_item"]);

export const rustTestDslFilterHook: ChunkingHook = {
  name: "rust-test-dsl-filter",

  filterNode(node: AstNode, code: string): boolean | undefined {
    // Keep every module/function on the generic candidate path. The process
    // hook claims only test-only containers; production output keeps the
    // existing generic shaping and parent identity.
    if (node.type === "mod_item" || node.type === "function_item") return true;
    // A declaration is a candidate only when it is test-only itself, so it
    // becomes its own test chunk; a production one stays out of discovery, as
    // before it was a candidate type at all (bd tea-rags-mcp-52wk3.9).
    if (TEST_ONLY_DECLARATION_TYPES.has(node.type)) return isInlineTestNode(node, code);
    return undefined;
  },

  process(_ctx: HookContext): void {
    // Filtering is the only responsibility of this hook.
  },
};
