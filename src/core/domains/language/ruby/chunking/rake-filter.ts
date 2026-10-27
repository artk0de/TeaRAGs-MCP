/**
 * Rake Filter Hook — the Rake half of Ruby's `call` filtering (bd
 * tea-rags-mcp-k0602). In a `.rake` file a `call` is a chunk candidate iff it
 * is a Rake DSL call: a `namespace` container or a task leaf. Every other call
 * (a task body's `Template.where(...)`) is rejected, so the scope chunker sees
 * only the DSL. Registered BEFORE the RSpec filter: the first verdict wins, and
 * a `.rake` file under `spec/` is still Rake, never a test.
 *
 * Rake is production code with its own DSL — `.rake` files are never test
 * files, whatever their directory.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook } from "../../../../contracts/types/chunker.js";

/** Calls whose block is a Rake namespace. */
export const RAKE_CONTAINER_METHODS: ReadonlySet<string> = new Set(["namespace"]);

/** Calls that define one Rake task. */
export const RAKE_TASK_METHODS: ReadonlySet<string> = new Set(["task", "multitask", "file", "rule"]);

const RAKE_DSL_METHODS: ReadonlySet<string> = new Set([...RAKE_CONTAINER_METHODS, ...RAKE_TASK_METHODS]);

export function isRakeFile(filePath: string): boolean {
  return filePath.endsWith(".rake");
}

/** The called method of a receiverless `call` (`task`, `namespace`); null for any other node. */
export function rakeCallName(node: AstNode): string | null {
  if (node.type !== "call") return null;
  return node.children.find((c) => c.type === "identifier")?.text ?? null;
}

export const rakeFilterHook: ChunkingHook = {
  name: "rake-filter",

  filterNode(node: AstNode, _code: string, filePath: string): boolean | undefined {
    if (node.type !== "call" || !isRakeFile(filePath)) return undefined;
    const methodName = rakeCallName(node);
    return methodName !== null && RAKE_DSL_METHODS.has(methodName);
  },

  process(): void {
    // No-op — filterNode narrows the candidates, the scope chunker claims them.
  },
};
