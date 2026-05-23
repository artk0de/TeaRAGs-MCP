import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

/**
 * Regression test for the symbolId stability fix in chunkOversizedNode
 * (tree-sitter.ts L194-220). Before the fix, oversized methods that
 * needed character-fallback chunking produced subChunks with
 * `metadata.symbolId === undefined` and `metadata.chunkType === "block"`,
 * which broke the "all chunks of one method share the same symbolId"
 * invariant the codegraph slice depends on (and which existing MCP
 * navigation already relies on for finding split methods).
 */
describe("TreeSitterChunker oversized method symbolId inheritance", () => {
  it("split chunks of one oversized function share the same symbolId and report chunkType=function", async () => {
    const fnName = "doWork";
    const body = "  console.log('x');\n".repeat(500); // ~10KB > maxChunkSize
    const code = `export function ${fnName}() {\n${body}}\n`;

    const config: ChunkerConfig = {
      chunkSize: 800,
      chunkOverlap: 50,
      maxChunkSize: 1500,
    };
    const chunker = new TreeSitterChunker(config);
    const chunks = await chunker.chunk(code, "src/big.ts", "typescript");

    const splits = chunks.filter((c) => c.metadata.parentSymbolId === fnName);
    expect(splits.length).toBeGreaterThan(1);
    for (const c of splits) {
      expect(c.metadata.symbolId).toBe(fnName);
      expect(c.metadata.chunkType).toBe("function");
    }
  });
});
