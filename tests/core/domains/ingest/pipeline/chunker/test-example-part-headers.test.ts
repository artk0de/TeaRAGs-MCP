/**
 * Every `#partN` of a split test example carries its example row
 * (bd tea-rags-mcp-l24yk).
 *
 * An example oversized on its own is line-cut by the engine's hard cap. j4jrn
 * made every part repeat the container header, so `#part2+` named the
 * `describe` — and nothing else: the `it` row that says which example the
 * rows belong to stayed in `#part1` alone, whereas a split method repeats its
 * signature on every part. Line ranges stay the part's own rows, so the parts
 * still tile the example exactly.
 *
 * All through the real `TreeSitterChunker`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX_CHUNK_SIZE = 600;

function partsOf(chunks: CodeChunk[], exampleName: string): CodeChunk[] {
  return chunks.filter(
    (c) => /#part\d+$/.test(c.metadata.symbolId ?? "") && (c.metadata.symbolId ?? "").includes(exampleName),
  );
}

function hasRow(chunk: CodeChunk, row: string): boolean {
  return chunk.content.split("\n").some((line) => line.trim() === row);
}

interface SplitExampleCase {
  language: string;
  path: string;
  containerRow: string;
  exampleRow: string;
  exampleName: string;
  code: string;
}

const statements = (make: (i: number) => string): string => Array.from({ length: 30 }, (_, i) => make(i)).join("\n");

const CASES: SplitExampleCase[] = [
  {
    language: "typescript",
    path: "tests/reranker.test.ts",
    containerRow: `describe("Reranker", () => {`,
    exampleRow: `it("ranks every candidate by its blended score", () => {`,
    exampleName: `it "ranks every candidate by its blended score"`,
    code: `describe("Reranker", () => {
  it("ranks every candidate by its blended score", () => {
${statements((i) => `    expect(rank(candidate${i}, weights)).toBeGreaterThan(${i});`)}
  });
});
`,
  },
  {
    language: "javascript",
    path: "test/router.test.js",
    containerRow: `describe("Router", () => {`,
    exampleRow: `it("dispatches every registered route", () => {`,
    exampleName: `it "dispatches every registered route"`,
    code: `describe("Router", () => {
  it("dispatches every registered route", () => {
${statements((i) => `    expect(router.dispatch("/route/${i}")).toBe(handler${i});`)}
  });
});
`,
  },
  {
    language: "ruby",
    path: "spec/router_spec.rb",
    containerRow: "RSpec.describe Router do",
    exampleRow: `it "dispatches every registered route" do`,
    exampleName: `it "dispatches every registered route"`,
    code: `RSpec.describe Router do
  it "dispatches every registered route" do
${statements((i) => `    expect(router.dispatch("/route/${i}")).to eq(handler_${i})`)}
  end
end
`,
  },
];

describe("TreeSitterChunker — every part of a split test example carries its example row (bd tea-rags-mcp-l24yk)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 300, chunkOverlap: 0, maxChunkSize: MAX_CHUNK_SIZE },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it.each(CASES)("$language: container row and example row on every part", async (c) => {
    const parts = partsOf(await chunker.chunk(c.code, c.path, c.language), c.exampleName);

    expect(parts.length).toBeGreaterThan(1);
    const offenders = parts
      .filter((p) => p.content.length > MAX_CHUNK_SIZE || !hasRow(p, c.containerRow) || !hasRow(p, c.exampleRow))
      .map((p) => `${p.metadata.symbolId} (${p.content.length}):\n${p.content}`);
    expect(offenders).toEqual([]);
  });

  it.each(CASES)("$language: the parts' line ranges still tile the example exactly", async (c) => {
    const parts = partsOf(await chunker.chunk(c.code, c.path, c.language), c.exampleName);
    const lines = c.code.split("\n");
    const exampleStart = lines.findIndex((l) => l.trim() === c.exampleRow) + 1;
    const exampleEnd = exampleStart + 31;

    expect(parts[0].startLine).toBe(exampleStart);
    expect(parts.at(-1)?.endLine).toBe(exampleEnd);
    for (let i = 1; i < parts.length; i++) expect(parts[i].startLine).toBe(parts[i - 1].endLine + 1);
  });
});
