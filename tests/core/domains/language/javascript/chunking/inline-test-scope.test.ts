import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

/**
 * Vitest in-source tests (`if (import.meta.vitest) { … }`) in a SOURCE file
 * chunk as a test scope; every other top-level `if` chunks as before.
 */
describe("TreeSitterChunker — Vitest in-source test blocks (JavaScript)", () => {
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());

  const inSourceFixture = `export function add(a, b) {
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
    const chunks = await chunker.chunk(inSourceFixture, "src/math.js", "javascript");

    const add = chunks.find((c) => c.metadata.symbolId === "add");
    expect(add?.metadata.chunkType).toBe("function");
    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(4);
  });

  it("emits the in-source block's example as a test chunk under the vitest scope", async () => {
    const chunks = await chunker.chunk(inSourceFixture, "src/math.js", "javascript");

    const tests = chunks.filter((c) => c.metadata.chunkType === "test");
    expect(tests.map((c) => c.metadata.symbolId)).toEqual(['math.vitest.it "adds"']);
    expect(tests[0].startLine).toBe(8);
    expect(tests[0].endLine).toBe(10);
    expect(tests[0].content).toContain('it("adds"');
  });

  it("stores the import.meta.vitest destructuring as test_setup content", async () => {
    const chunks = await chunker.chunk(inSourceFixture, "src/math.js", "javascript");

    const setup = chunks.filter((c) => c.metadata.chunkType === "test_setup");
    expect(setup).toHaveLength(1);
    expect(setup[0].content).toContain("const { it, expect } = import.meta.vitest;");
    expect(setup[0].startLine).toBe(7);
  });

  const nestedFixture = `export function nestedInSource(value) {
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
    const chunks = await chunker.chunk(nestedFixture, "src/math.js", "javascript");

    const example = chunks.find((c) => c.metadata.symbolId === 'math.vitest.it "doubles"');
    expect(example?.metadata.chunkType).toBe("test");
    expect(example?.metadata.parentSymbolId).toBe("math.vitest");
    expect(chunks.find((c) => c.metadata.symbolId === "math.vitest")?.metadata.chunkType).toBe("test_setup");
  });

  it("keeps the function's other rows in its function chunk, without the in-source block", async () => {
    const chunks = await chunker.chunk(nestedFixture, "src/math.js", "javascript");

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
    const code = `export function clamp(value) {
  const limit = 100;
  if (value > limit) {
    console.log("clamping an out-of-range value to the configured limit");
    return limit;
  }
  return value;
}
`;
    const chunks = await chunker.chunk(code, "src/clamp.js", "javascript");

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
    const code = `export function init() {
  console.log("starting the service with the configured environment");
}

if (process.env.X) {
  init();
}
`;
    const chunks = await chunker.chunk(code, "src/boot.js", "javascript");

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

/** A chunk whose type sets `payload.isTest` — anything else is production code. */
const isTestChunk = (chunk: { metadata: { chunkType?: string } }): boolean =>
  chunk.metadata.chunkType === "test" || chunk.metadata.chunkType === "test_setup";

describe("TreeSitterChunker — an in-source block never becomes production code (52wk3.9)", () => {
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());

  const UNRECOGNISED_CALL = 'import.meta.vitest.it("t", () => expect(1).toBe(1));';
  const TINY_EXAMPLE = 'it("t", () => {});';
  const topLevel = (body: string): string =>
    `export function add(a, b) {\n  const total = a + b;\n  return total;\n}\n\nif (import.meta.vitest) {\n  ${body}\n}\n`;
  const nested = (body: string): string =>
    `export function scale(value) {\n  const scaled = value * 3;\n  if (import.meta.vitest) {\n    ${body}\n  }\n  return scaled;\n}\n`;
  const productionHolding = (chunks: { content: string; metadata: { chunkType?: string } }[], text: string): string[] =>
    chunks.filter((chunk) => !isTestChunk(chunk) && chunk.content.includes(text)).map((c) => c.content);

  const SHORT_SETUP_SUITE = 'describe("a suite holding only a short fixture", () => {\n    const x = 1;\n  });';

  for (const [label, body, marker] of [
    ["a call the DSL reader does not recognise", UNRECOGNISED_CALL, 'it("t"'],
    ["one tiny example", TINY_EXAMPLE, 'it("t"'],
    ["a suite whose only setup is under the noise floor", SHORT_SETUP_SUITE, "const x = 1;"],
  ] as const) {
    it(`chunks a top-level block with ${label} as test code`, async () => {
      const chunks = await chunker.chunk(topLevel(body), "src/math.js", "javascript");

      expect(chunks.filter((c) => c.metadata.chunkType === "test" && c.content.includes(marker))).not.toHaveLength(0);
      expect(productionHolding(chunks, "import.meta.vitest")).toEqual([]);
      expect(productionHolding(chunks, marker)).toEqual([]);
      expect(chunks.find((c) => c.metadata.symbolId === "add")?.content).toContain("return total;");
    });

    it(`chunks a block with ${label} inside a function body as test code`, async () => {
      const chunks = await chunker.chunk(nested(body), "src/math.js", "javascript");

      expect(chunks.filter((c) => c.metadata.chunkType === "test" && c.content.includes(marker))).not.toHaveLength(0);
      expect(productionHolding(chunks, "import.meta.vitest")).toEqual([]);
      expect(productionHolding(chunks, marker)).toEqual([]);
      expect(chunks.some((c) => c.metadata.symbolId === "scale" && c.content.includes("return scaled;"))).toBe(true);
    });
  }

  it("ids a block the DSL reader yields nothing for as the vitest scope, under the file subject", async () => {
    const chunks = await chunker.chunk(topLevel(UNRECOGNISED_CALL), "src/math.js", "javascript");

    const holders = chunks.filter((c) => c.content.includes("import.meta.vitest.it"));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId])).toEqual([["test", "math.vitest"]]);
  });

  it("parents that block as a claimed block's scope chunk: under the file subject, by its `if`", async () => {
    const chunks = await chunker.chunk(topLevel(UNRECOGNISED_CALL), "src/math.js", "javascript");

    const block = chunks.find((c) => c.metadata.symbolId === "math.vitest");
    expect([block?.metadata.parentSymbolId, block?.metadata.parentType]).toEqual(["math", "if_statement"]);
  });
});

describe("TreeSitterChunker — residual in-source leaks into production chunks (52wk3.9)", () => {
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());

  const productionHolding = (chunks: { content: string; metadata: { chunkType?: string } }[], text: string): string[] =>
    chunks.filter((chunk) => !isTestChunk(chunk) && chunk.content.includes(text)).map((c) => c.content);

  const SHORT_NESTED = `export function scale(value) {
  const scaled = value * 3;
  if (import.meta.vitest) { it("s", () => {}); }
  return scaled;
}
`;

  it("chunks a nested in-source block under the noise floor as test code, out of the function chunk", async () => {
    const chunks = await chunker.chunk(SHORT_NESTED, "src/math.js", "javascript");

    expect(chunks.filter((c) => isTestChunk(c) && c.content.includes('it("s"'))).not.toHaveLength(0);
    expect(productionHolding(chunks, "import.meta.vitest")).toEqual([]);
    expect(productionHolding(chunks, 'it("s"')).toEqual([]);
    expect(chunks.some((c) => c.metadata.symbolId === "scale" && c.content.includes("return scaled;"))).toBe(true);
  });

  it("names a nested in-source block the engine emits as a leaf `vitest`, under its enclosing scope", async () => {
    const chunks = await chunker.chunk(SHORT_NESTED, "src/math.js", "javascript");

    const holders = chunks.filter((c) => c.content.includes('it("s"'));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId])).toEqual([["test", "scale.vitest"]]);
  });

  it("keeps a block whose suite yields no hook chunk out of every production chunk", async () => {
    const suite = 'describe("an empty suite with a long enough title to pass", () => {});';
    const topLevel = `export function add(a, b) {\n  const total = a + b;\n  return total;\n}\n\nif (import.meta.vitest) {\n  ${suite}\n}\n`;
    const nested = `export function scale(value) {\n  const scaled = value * 3;\n  if (import.meta.vitest) {\n    ${suite}\n  }\n  return scaled;\n}\n`;

    for (const code of [topLevel, nested]) {
      const chunks = await chunker.chunk(code, "src/math.js", "javascript");
      expect(chunks.filter((c) => isTestChunk(c) && c.content.includes("an empty suite"))).not.toHaveLength(0);
      expect(productionHolding(chunks, "an empty suite")).toEqual([]);
      expect(productionHolding(chunks, "import.meta.vitest")).toEqual([]);
    }
  });

  it("chunks a function with plain short ifs exactly as before", async () => {
    const code = `export function guard(value) {
  const limit = 100;
  if (value < 0) { return 0; }
  if (value > limit) return limit;
  return value;
}
`;
    const chunks = await chunker.chunk(code, "src/guard.js", "javascript");

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
        symbolId: "guard",
        startLine: 1,
        endLine: 6,
        content:
          "function guard(value) {\n  const limit = 100;\n  if (value < 0) { return 0; }\n  if (value > limit) return limit;\n  return value;\n}",
      },
    ]);
  });
});

/** Output of this fixture before Vitest in-source support, recorded on the base commit. */
const PLAIN_IF_BASELINE = [{ chunkType: "function", symbolId: "init", startLine: 1, endLine: 6 }];
