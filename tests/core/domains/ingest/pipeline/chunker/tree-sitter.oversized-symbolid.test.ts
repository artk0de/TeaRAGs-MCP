import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

const testLanguageFactoryDescriptor = new LanguageFactory();

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
    const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
    const chunks = await chunker.chunk(code, "src/big.ts", "typescript");

    const splits = chunks.filter((c) => c.metadata.parentSymbolId === fnName);
    expect(splits.length).toBeGreaterThan(1);
    // INVARIANT CHANGED (bd tea-rags-mcp-y5vx4): the splits no longer share
    // the bare id — they are `doWork#part1..N`, numbered once, all under
    // parentSymbolId `doWork`. The codegraph slice folds `#partN` onto the
    // symbol, so "every split maps to one symbolId" still holds there.
    splits.forEach((c, i) => {
      expect(c.metadata.symbolId).toBe(`${fnName}#part${i + 1}`);
      expect(c.metadata.chunkType).toBe("function");
    });
  });
});

/**
 * bd tea-rags-mcp-xdt5u — a type-only declaration (interface, type alias) too
 * large for one chunk and with no method children to extract used to split
 * into parts stamped `chunkType: "function"`. That label passed the
 * `coreLogic` filter, so `decomposition` ranked a 400-line interface as a
 * god-method by its `methodLines`. A part carries the chunkType its symbol
 * carries unsplit: splitting is a size decision, never a kind decision.
 */
describe("TreeSitterChunker oversized type-only declaration chunkType", () => {
  const config: ChunkerConfig = { chunkSize: 800, chunkOverlap: 50, maxChunkSize: 1500 };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);

  const members = (count: number): string => Array.from({ length: count }, (_, i) => `  field${i}: string;\n`).join("");

  const declarations = [
    { kind: "interface", name: "Contract", source: (n: number) => `export interface Contract {\n${members(n)}}\n` },
    { kind: "type alias", name: "Shape", source: (n: number) => `export type Shape = {\n${members(n)}};\n` },
  ];

  it.each(declarations)("parts of an oversized $kind carry the chunkType of the unsplit $kind", async (decl) => {
    const small = await chunker.chunk(decl.source(3), "src/small.ts", "typescript");
    const whole = small.find((c) => c.metadata.symbolId === decl.name);
    expect(whole, `unsplit ${decl.kind} chunk`).toBeDefined();

    const big = await chunker.chunk(decl.source(200), "src/big.ts", "typescript");
    const parts = big.filter((c) => (c.metadata.symbolId ?? "").startsWith(`${decl.name}#part`));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.metadata.chunkType).toBe(whole?.metadata.chunkType);
      expect(part.metadata.chunkType).not.toBe("function");
    }
  });
});
