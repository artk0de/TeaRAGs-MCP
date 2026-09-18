/**
 * `.mts` / `.cts` are TypeScript on the ingest side too (bd tea-rags-mcp-1y13c):
 * the extension routes to the `typescript` language and the file chunks exactly
 * as a `.ts` module does. Without it the scanner never offered the file, so an
 * ESM/CJS TypeScript module had no chunks while the codegraph walked it.
 */
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { detectLanguage } from "../../../../../../src/core/domains/ingest/pipeline/chunker/utils/language-detector.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

const MODULE = `
export class Pool {
  run(): number {
    return 1;
  }
}

export function start(): Pool {
  return new Pool();
}
`;

describe("ingest .mts / .cts as TypeScript (bd tea-rags-mcp-1y13c)", () => {
  const chunker = new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );

  it("routes both extensions to the typescript language", () => {
    expect(detectLanguage("src/worker.mts")).toBe("typescript");
    expect(detectLanguage("src/legacy.cts")).toBe("typescript");
  });

  it.each(["src/worker.mts", "src/legacy.cts"])("chunks %s as the same module in .ts does", async (relPath) => {
    const asTs = await chunker.chunk(MODULE, "src/worker.ts", detectLanguage("src/worker.ts"));
    const chunks = await chunker.chunk(MODULE, relPath, detectLanguage(relPath));
    expect(chunks.map((chunk) => chunk.metadata.symbolId)).toEqual(asTs.map((chunk) => chunk.metadata.symbolId));
    // Not the character fallback an unknown language gets: an AST chunk named
    // by the TypeScript symbolId rules.
    expect(chunks.map((chunk) => chunk.metadata.symbolId)).toContain("Pool");
  });
});
