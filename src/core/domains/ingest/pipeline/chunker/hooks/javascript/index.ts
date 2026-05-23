/**
 * JavaScript chunker hooks.
 *
 * Filter chain ordering (per `.claude/rules/chunker-hooks.md`):
 *   1. `jsAssignmentFilterHook` — filter-only: keep
 *      `expression_statement` / `lexical_declaration` /
 *      `variable_declaration` nodes only when they carry a function value,
 *      so we don't emit chunks for `const x = 1` / `import.meta.url` /
 *      bare statements that have no symbolId.
 *
 * The symbol resolver (`symbol-resolver.ts`) is a pure helper consumed
 * directly by the chunker — not part of the hook chain — because it
 * needs to run AFTER the filter passes a node and BEFORE the chunk is
 * pushed (i.e. inside `chunkSingleNode`, not at hook-process time).
 *
 * bd tea-rags-mcp-kfzx
 */
import type { ChunkingHook } from "../types.js";
import { jsAssignmentFilterHook } from "./assignment-filter.js";

export const javascriptHooks: ChunkingHook[] = [jsAssignmentFilterHook];

export {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
  type JsAssignmentSymbol,
} from "./symbol-resolver.js";
