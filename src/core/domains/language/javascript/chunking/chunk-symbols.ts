/**
 * `chunkSymbols` — the engine-facing JavaScript chunk-symbol capability.
 *
 * The node-level analog of Ruby's `macroSymbols`: it maps a single chunkable
 * node to the synthetic `ChunkSymbol[]` the engine emits, with symbolIds ALREADY
 * composed (no further scope join). It collapses the three branches the chunker
 * engine formerly inlined (`tree-sitter.ts:chunkSingleNode`'s `language ===
 * "javascript"` block) into ONE provider call, so the engine stays generic — it
 * just emits each returned symbol at `index + i`. bd tea-rags-mcp-kfzx / z95o /
 * d1f8.
 *
 * Precedence (behaviour-preserving — exactly the former engine branch order):
 *   1. `methods.forEach` HTTP-verb dispatch fan-out — when it matches, the
 *      dispatch SET WINS and is returned alone (the former engine `return`ed
 *      before reaching the assignment branch).
 *   2. Otherwise the assignment / CommonJS shape (`extractJsAssignmentSymbol`)
 *      — at most one symbol — FOLLOWED IN ORDER by its nested
 *      `Object.defineProperty(this, …)` / `defineGetter(this, …)` getter
 *      siblings (`extractJsNestedDefinePropertyThisSymbols`). The siblings are
 *      only consulted when the assignment matched (the former engine emitted
 *      them inside the `if (jsSymbol)` block).
 *   3. No match → `[]` (engine falls through to its default name extraction).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkSymbol } from "../../../../contracts/types/chunker.js";
import {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
} from "./symbol-resolver.js";

export function jsChunkSymbols(node: AstNode): ChunkSymbol[] {
  // 1. Dispatch fan-out wins outright when present.
  const dispatch = extractJsForEachDispatchSymbols(node);
  if (dispatch && dispatch.length > 0) {
    return dispatch.map((s) => ({ symbolId: s.symbolId, name: s.name }));
  }

  // 2. Assignment / CommonJS shape, then its nested-defineProperty siblings.
  const assignment = extractJsAssignmentSymbol(node);
  if (assignment) {
    const out: ChunkSymbol[] = [{ symbolId: assignment.symbolId, name: assignment.name }];
    for (const nested of extractJsNestedDefinePropertyThisSymbols(node)) {
      out.push({ symbolId: nested.symbolId, name: nested.name });
    }
    return out;
  }

  // 3. Nothing matched.
  return [];
}
