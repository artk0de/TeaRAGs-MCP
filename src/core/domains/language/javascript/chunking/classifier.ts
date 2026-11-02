/**
 * JavaScript node→chunk classifier. A thin adapter over `jsChunkSymbols` (the
 * former `chunkSymbols` capability): the provider has ALREADY composed each
 * symbolId, so non-empty results map to an `emit` decision with chunkType
 * "function" (the engine formerly hardcoded "function" for these), and an empty
 * result means the node is not a CommonJS / prototype / dispatch / defineProperty
 * shape — pass through to the engine's default extraction. Precedence
 * (dispatch-set wins; else assignment + nested defineProperty siblings) is owned
 * by `jsChunkSymbols`. bd tea-rags-mcp-kfzx / z95o / d1f8.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkDecision, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { jsChunkSymbols } from "./chunk-symbols.js";
import { inlineTestBlockClassifier } from "./test-scope-chunker.js";

export class JsChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: AstNode, filePath?: string): ChunkDecision {
    // A Vitest in-source block is test code however short (bd tea-rags-mcp-52wk3.9).
    if (node.type === "if_statement") return inlineTestBlockClassifier.classifyNode(node, filePath);
    const syms = jsChunkSymbols(node);
    if (syms.length === 0) return { kind: "passthrough" };
    return {
      kind: "emit",
      chunks: syms.map((s) => ({ name: s.name, symbolId: s.symbolId, chunkType: "function" })),
    };
  }
}
