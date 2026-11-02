import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

/**
 * Vitest in-source tests (`if (import.meta.vitest) { … }`) in a SOURCE file
 * chunk as a test scope; every other top-level `if` chunks as before.
 */
describe("TreeSitterChunker — Vitest in-source test blocks (TypeScript)", () => {
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());

  const inSourceFixture = `export function add(a: number, b: number): number {
  const total = a + b;
  return total;
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
}
`;

  it("keeps the production function a function chunk", async () => {
    const chunks = await chunker.chunk(inSourceFixture, "src/math.ts", "typescript");

    const add = chunks.find((c) => c.metadata.symbolId === "add");
    expect(add?.metadata.chunkType).toBe("function");
    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(4);
  });

  it("emits the in-source block's example as a test chunk under the vitest scope", async () => {
    const chunks = await chunker.chunk(inSourceFixture, "src/math.ts", "typescript");

    const tests = chunks.filter((c) => c.metadata.chunkType === "test");
    expect(tests.map((c) => c.metadata.symbolId)).toEqual(['math.vitest.it "adds"']);
    expect(tests[0].startLine).toBe(8);
    expect(tests[0].endLine).toBe(10);
    expect(tests[0].content).toContain('it("adds"');
  });

  it("stores the import.meta.vitest destructuring as test_setup content", async () => {
    const chunks = await chunker.chunk(inSourceFixture, "src/math.ts", "typescript");

    const setup = chunks.filter((c) => c.metadata.chunkType === "test_setup");
    expect(setup).toHaveLength(1);
    expect(setup[0].content).toContain("const { it, expect } = import.meta.vitest;");
    expect(setup[0].startLine).toBe(7);
  });

  const nestedFixture = `export function nestedInSource(value: number): number {
  const doubled = value * 2;
  if (import.meta.vitest) {
    const { it, expect } = import.meta.vitest;
    it("doubles", () => {
      expect(nestedInSource(2)).toBe(4);
    });
  }
  return doubled;
}
`;

  it("chunks an in-source block inside a function body as the top-level block's test chunks", async () => {
    const chunks = await chunker.chunk(nestedFixture, "src/math.ts", "typescript");

    const example = chunks.find((c) => c.metadata.symbolId === 'math.vitest.it "doubles"');
    expect(example?.metadata.chunkType).toBe("test");
    expect(example?.metadata.parentSymbolId).toBe("math.vitest");
    expect(chunks.find((c) => c.metadata.symbolId === "math.vitest")?.metadata.chunkType).toBe("test_setup");
  });

  it("keeps the function's other rows in its function chunk, without the in-source block", async () => {
    const chunks = await chunker.chunk(nestedFixture, "src/math.ts", "typescript");

    const fn = chunks.filter((c) => c.metadata.symbolId === "nestedInSource");
    expect(fn.length).toBeGreaterThan(0);
    for (const chunk of fn) {
      expect(chunk.metadata.chunkType).toBe("function");
      expect(chunk.content).not.toContain('it("doubles"');
      expect(chunk.content).not.toContain("import.meta.vitest");
    }
    expect(fn.some((c) => c.content.includes("return doubled;"))).toBe(true);
  });

  it("chunks a function with a plain inner if exactly as before", async () => {
    const code = `export function clamp(value: number): number {
  const limit = 100;
  if (value > limit) {
    console.log("clamping an out-of-range value to the configured limit");
    return limit;
  }
  return value;
}
`;
    const chunks = await chunker.chunk(code, "src/clamp.ts", "typescript");

    expect(
      chunks.map((c) => ({
        chunkType: c.metadata.chunkType,
        symbolId: c.metadata.symbolId,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
      })),
    ).toEqual([
      {
        chunkType: "function",
        symbolId: "clamp",
        startLine: 1,
        endLine: 8,
        content: code.trim().replace(/^export /, ""),
      },
    ]);
  });

  it("chunks a plain top-level if exactly as before", async () => {
    const code = `export function init(): void {
  console.log("starting the service with the configured environment");
}

if (process.env.X) {
  init();
}
`;
    const chunks = await chunker.chunk(code, "src/boot.ts", "typescript");

    expect(
      chunks.map((c) => ({
        chunkType: c.metadata.chunkType,
        symbolId: c.metadata.symbolId,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    ).toEqual(PLAIN_IF_BASELINE);
  });
});

/** Output of this fixture before Vitest in-source support, recorded on the base commit. */
const PLAIN_IF_BASELINE = [{ chunkType: "function", symbolId: "init", startLine: 1, endLine: 6 }];
