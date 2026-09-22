/**
 * `.mjs` / `.cjs` are JavaScript on the ingest side too (bd tea-rags-mcp-oxodb):
 * the extension routes to the `javascript` language and the file chunks exactly
 * as a `.js` module does. Without it the scanner never offered the file, so an
 * ESM/CJS JavaScript module had no chunks while the codegraph walked it.
 */
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { detectLanguage } from "../../../../../../src/core/domains/ingest/pipeline/chunker/utils/language-detector.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

// Bodies long enough to clear the javascript provider's minimum-chunk filter —
// a fixture of one-liners collapses to nothing and measures the filter, not the
// extension routing.
const MODULE = `
export function greet(name) {
  const greeting = 'Hello, ' + name;
  console.log(greeting);
  return greeting;
}

export function farewell(name) {
  const goodbye = 'Goodbye, ' + name;
  console.log(goodbye);
  return goodbye;
}

export class Pool {
  drain() {
    const drained = [];
    for (let i = 0; i < 10; i++) {
      drained.push(i);
    }
    return drained;
  }

  size() {
    return 42;
  }
}
`;

describe("ingest .mjs / .cjs as JavaScript (bd tea-rags-mcp-oxodb)", () => {
  const chunker = new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );

  it("routes both extensions to the javascript language", () => {
    expect(detectLanguage("src/app.mjs")).toBe("javascript");
    expect(detectLanguage("src/legacy.cjs")).toBe("javascript");
  });

  it.each(["src/app.mjs", "src/legacy.cjs"])("chunks %s as the same module in .js does", async (relPath) => {
    const asJs = await chunker.chunk(MODULE, "src/app.js", detectLanguage("src/app.js"));
    const chunks = await chunker.chunk(MODULE, relPath, detectLanguage(relPath));
    expect(chunks.map((chunk) => chunk.metadata.symbolId)).toEqual(asJs.map((chunk) => chunk.metadata.symbolId));
    // Not the character fallback an unknown language gets: AST chunks named
    // by the JavaScript symbolId rules.
    expect(chunks.map((chunk) => chunk.metadata.symbolId)).toContain("greet");
    expect(chunks.map((chunk) => chunk.metadata.symbolId)).toContain("Pool#drain");
  });
});
