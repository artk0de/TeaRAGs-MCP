import { describe, expect, it } from "vitest";

import { CodeChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/code.js";
import { DocChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/doc.js";
import { FileLevelGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/file-level.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { ExploreResult } from "../../../../../src/core/domains/explore/strategies/types.js";

/** Search hits arrive as ExploreResult; the groupers consume ScrollChunk. */
function asResults(chunks: ScrollChunk[], scores: number[]): ExploreResult[] {
  return chunks.map((c, i) => ({ id: c.id, score: scores[i], payload: c.payload }));
}

describe("FileLevelGrouper", () => {
  describe("group (dedup by file)", () => {
    // Moved from BaseExploreStrategy#groupByFile tests — the invariant is
    // unchanged, only its home. Grouping is no longer a responsibility of the
    // strategy hub (tea-rags-mcp-zrma).
    it("deduplicates by relativePath, keeping highest-scored per file", () => {
      const results: ExploreResult[] = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "chunk1" } },
        { id: "2", score: 0.8, payload: { relativePath: "src/a.ts", content: "chunk2" } },
        { id: "3", score: 0.7, payload: { relativePath: "src/b.ts", content: "chunk3" } },
        { id: "4", score: 0.6, payload: { relativePath: "src/c.ts", content: "chunk4" } },
      ];

      const grouped = FileLevelGrouper.group(results, 10);

      expect(grouped).toHaveLength(3);
      expect(grouped[0].payload?.relativePath).toBe("src/a.ts");
      expect(grouped[0].score).toBe(0.9);
    });

    it("respects limit parameter", () => {
      const results: ExploreResult[] = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
        { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
        { id: "3", score: 0.7, payload: { relativePath: "src/c.ts" } },
      ];

      expect(FileLevelGrouper.group(results, 2)).toHaveLength(2);
    });

    it("keeps the representative payload of the highest-scored hit", () => {
      const results: ExploreResult[] = [
        { id: "top", score: 0.9, payload: { relativePath: "src/a.ts", symbolId: "Alpha", content: "alpha body" } },
        { id: "low", score: 0.4, payload: { relativePath: "src/a.ts", symbolId: "Beta", content: "beta body" } },
      ];

      const [file] = FileLevelGrouper.group(results, 10);

      expect(file.id).toBe("top");
      expect(file.payload?.symbolId).toBe("Alpha");
      expect(file.payload?.content).toBe("alpha body");
    });
  });

  describe("group (members outline)", () => {
    const codeChunks: ScrollChunk[] = [
      {
        id: "c-1",
        payload: {
          name: "Reranker",
          symbolId: "Reranker",
          chunkType: "class",
          relativePath: "src/reranker.ts",
          content: "class Reranker {}",
          startLine: 5,
          endLine: 50,
          language: "typescript",
        },
      },
      {
        id: "c-2",
        payload: {
          name: "rerank",
          symbolId: "Reranker#rerank",
          chunkType: "function",
          relativePath: "src/reranker.ts",
          content: "rerank() {}",
          startLine: 10,
          endLine: 20,
          language: "typescript",
          parentSymbolId: "Reranker",
        },
      },
      {
        id: "c-3",
        payload: {
          name: "createReranker",
          symbolId: "createReranker",
          chunkType: "function",
          relativePath: "src/reranker.ts",
          content: "function createReranker() {}",
          startLine: 55,
          endLine: 60,
          language: "typescript",
        },
      },
    ];

    it("attaches a members outline listing what matched inside the file", () => {
      const [file] = FileLevelGrouper.group(asResults(codeChunks, [0.9, 0.8, 0.7]), 10);

      const lines = (file.payload?.members as string).split("\n");
      expect(lines[0]).toBe("src/reranker.ts");
      expect(lines[1]).toBe("  Reranker");
      expect(lines[2]).toBe("    Reranker#rerank");
      expect(lines[3]).toBe("  createReranker");
    });

    // tea-rags-mcp-zrma: one outline format across the product. level=file must
    // hand back byte-identical text to what find_symbol(relativePath) renders
    // for the same chunk set, so an agent learns a single shape.
    it("renders members byte-identically to the find_symbol file outline", () => {
      const [file] = FileLevelGrouper.group(asResults(codeChunks, [0.9, 0.8, 0.7]), 10);

      expect(file.payload?.members).toBe(CodeChunkGrouper.groupFile(codeChunks).payload?.content);
    });

    it("renders a markdown TOC for documentation hits", () => {
      const docChunks: ScrollChunk[] = [
        {
          id: "doc-1",
          payload: {
            symbolId: "readme-chunk-0",
            parentSymbolId: "readme-abc123",
            relativePath: "README.md",
            language: "markdown",
            isDocumentation: true,
            content: "# Getting Started\n\nSome intro text.",
            startLine: 1,
            endLine: 10,
            headingPath: [{ depth: 1, text: "Getting Started" }],
          },
        },
        {
          id: "doc-2",
          payload: {
            symbolId: "readme-chunk-1",
            parentSymbolId: "readme-abc123",
            relativePath: "README.md",
            language: "markdown",
            isDocumentation: true,
            content: "## Installation\n\nRun npm install.",
            startLine: 11,
            endLine: 20,
            headingPath: [
              { depth: 1, text: "Getting Started" },
              { depth: 2, text: "Installation" },
            ],
          },
        },
      ];

      const [file] = FileLevelGrouper.group(asResults(docChunks, [0.9, 0.8]), 10);

      const lines = (file.payload?.members as string).split("\n");
      expect(lines[0]).toBe("# Getting Started  readme-chunk-0");
      expect(lines[1]).toBe("  ## Installation  readme-chunk-1");
      expect(file.payload?.members).toBe(DocChunkGrouper.group(docChunks).payload?.content);
    });

    it("builds the outline per file, not across files", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "a-1",
          payload: {
            name: "alpha",
            symbolId: "alpha",
            relativePath: "src/a.ts",
            content: "function alpha() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "b-1",
          payload: {
            name: "beta",
            symbolId: "beta",
            relativePath: "src/b.ts",
            content: "function beta() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const grouped = FileLevelGrouper.group(asResults(chunks, [0.9, 0.8]), 10);

      expect(grouped[0].payload?.members).toBe("src/a.ts\n  alpha");
      expect(grouped[1].payload?.members).toBe("src/b.ts\n  beta");
    });

    it("omits members when the hits carry no nameable symbol", () => {
      const results: ExploreResult[] = [
        { id: "d-1", score: 0.9, payload: { relativePath: "docs/plain.md", isDocumentation: true, content: "text" } },
      ];

      const [file] = FileLevelGrouper.group(results, 10);

      expect(file.payload?.members).toBeUndefined();
    });

    it("leaves results without a payload untouched", () => {
      const grouped = FileLevelGrouper.group([{ id: "x", score: 0.5 }], 10);

      expect(grouped).toHaveLength(1);
      expect(grouped[0].payload).toBeUndefined();
    });
  });
});
