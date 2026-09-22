/**
 * Swift nested-function filter — keeps a `func` or `init` declared inside
 * another function's body out of the chunkable set.
 *
 * Two reasons, one preventive and one corrective.
 *
 * PREVENTIVE. `canRecurseAsContainer` (`chunker/tree-sitter.ts`) treats a child
 * as a container when it is a scope-container type OR when the language simply
 * HAS a hook chain — a bare `(langConfig.hooks?.length ?? 0) > 0`. So the
 * moment Swift registers any hook, a method holding a nested `func` of 50+
 * characters starts recursing, and the engine emits only the inner function
 * while `Calculator#outerCalculation` disappears. That is precisely the
 * shadowing bd tea-rags-mcp-07fr documents for Ruby and Python.
 *
 * CORRECTIVE. A TOP-LEVEL Swift `func` already loses itself today, before any
 * hook exists: `alwaysExtractChildren` sends every chunkable node down the
 * child-extraction path regardless of size, so a top-level function with a
 * nested one emits `outerCalculation#innerAccumulate` and nothing for
 * `outerCalculation` — `find_symbol("outerCalculation")` returns empty.
 * Rejecting the nested declaration leaves the outer function a single chunk
 * that still CONTAINS the inner one as text, which is what bd 07fr concluded is
 * right: decorator factories and helper closures rarely need their own search
 * hit, but the symbol that encloses them must stay addressable.
 *
 * The predicate is an ancestor walk rather than a parent check so it also
 * covers a func declared inside a LOCAL type inside a function body. It does
 * not fire for a func inside a computed property's accessor — no `function_body`
 * on that path — which keeps such members chunked exactly as they are today.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook } from "../../../../contracts/types/chunker.js";

/** Declaration types the Swift chunker treats as child chunks. */
const CHUNKABLE_DECLARATION_TYPES: ReadonlySet<string> = new Set(["function_declaration", "init_declaration"]);

/** tree-sitter-swift wraps every `func` / `init` body in this node. */
const FUNCTION_BODY_TYPE = "function_body";

/** True when any ancestor of `node` is a function body. */
export function isNestedInsideFunctionBody(node: AstNode): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === FUNCTION_BODY_TYPE) return true;
  }
  return false;
}

/**
 * Filter hook (chain position 1). `filterNode` only — `process` is a no-op, so
 * it never touches `ctx.bodyChunks`. Returns `undefined` for every node type it
 * has no business judging, per the `ChunkingHook` contract.
 */
export const swiftNestedFunctionFilterHook: ChunkingHook = {
  name: "swiftNestedFunctionFilter",

  filterNode(node: AstNode): boolean | undefined {
    if (!CHUNKABLE_DECLARATION_TYPES.has(node.type)) return undefined;
    return !isNestedInsideFunctionBody(node);
  },

  process(): void {
    // No-op — filterNode carries this hook's whole contribution.
  },
};
