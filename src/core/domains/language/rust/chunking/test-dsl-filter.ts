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

export const rustTestDslFilterHook: ChunkingHook = {
  name: "rust-test-dsl-filter",

  filterNode(node: AstNode): boolean | undefined {
    // Keep every module/function on the generic candidate path. The process
    // hook claims only test-only containers; production output keeps the
    // existing generic shaping and parent identity.
    if (node.type === "mod_item" || node.type === "function_item") return true;
    return undefined;
  },

  process(_ctx: HookContext): void {
    // Filtering is the only responsibility of this hook.
  },
};
