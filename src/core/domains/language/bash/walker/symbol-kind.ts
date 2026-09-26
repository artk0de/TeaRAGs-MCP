/**
 * Bash symbol kinds (tea-rags-mcp-vi0wx) — the declaration kind of every node
 * `bashNameOf` names, stamped on its chunk as `ChunkExtraction.symbolKind`.
 *
 * Bash has no class/module/interface concept — only a `function_definition`,
 * and both written forms (`function f {}` and `f() {}`) parse to that SAME
 * node type (verified against tree-sitter-bash: identical
 * `(function_definition name: (word) body: …)` shape either way). So
 * `function` is the only kind this language ever emits, matching the plan's
 * "bash: function only" row.
 *
 * Every other chunkable node — a top-level `command` the CONTENT chunker
 * keeps so a bare script body is still indexed (`chunking/classifier.ts`,
 * bd tea-rags-mcp-lyo4p) — never reaches a codegraph chunk at all: `bashNameOf`
 * is the only gate `collectSymbols` uses to decide what becomes one, and it
 * names nothing but `function_definition`. Bash has no position-dependent
 * kind either (a nested function is still a function), so the mapping reads
 * the node type alone.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export function symbolKindOf(nodeType: string): SymbolDefinitionKind | undefined {
  return nodeType === "function_definition" ? "function" : undefined;
}
