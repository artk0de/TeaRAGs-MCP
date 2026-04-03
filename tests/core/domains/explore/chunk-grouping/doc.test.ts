import { describe, expect, it } from "vitest";

import { DocChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/doc.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";

describe("DocChunkGrouper", () => {
  describe("group (doc outline)", () => {
    it("renders TOC with heading hierarchy and symbolId references", () => {
      const chunks: ScrollChunk[] = [
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
            git: {
              file: { commitCount: 5, ageDays: 60 },
              chunk: { commitCount: 2, ageDays: 10 },
            },
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
            git: {
              file: { commitCount: 5, ageDays: 60 },
              chunk: { commitCount: 1, ageDays: 3 },
            },
          },
        },
        {
          id: "doc-3",
          payload: {
            symbolId: "readme-chunk-2",
            parentSymbolId: "readme-abc123",
            relativePath: "README.md",
            language: "markdown",
            isDocumentation: true,
            content: "## Usage\n\nImport and call.",
            startLine: 21,
            endLine: 30,
            headingPath: [
              { depth: 1, text: "Getting Started" },
              { depth: 2, text: "Usage" },
            ],
            git: {
              file: { commitCount: 5, ageDays: 60 },
            },
          },
        },
      ];

      const result = DocChunkGrouper.group(chunks);

      expect(result.id).toBe("doc-1");
      expect(result.score).toBe(1.0);

      // symbolId set to parentSymbolId (doc parent hash)
      expect(result.payload?.symbolId).toBe("readme-abc123");
      expect(result.payload?.isDocumentation).toBe(true);

      // TOC content with headings
      const content = result.payload?.content as string;
      const lines = content.split("\n");
      // depth=1: no indent, single #
      expect(lines[0]).toBe("# Getting Started  readme-chunk-0");
      // depth=2: 2-space indent, ##
      expect(lines[1]).toBe("  ## Installation  readme-chunk-1");
      expect(lines[2]).toBe("  ## Usage  readme-chunk-2");

      // Merged headingPath (deduplicated)
      const hp = result.payload?.headingPath as { depth: number; text: string }[];
      expect(hp).toHaveLength(3);
      expect(hp[0]).toEqual({ depth: 1, text: "Getting Started" });
      expect(hp[1]).toEqual({ depth: 2, text: "Installation" });
      expect(hp[2]).toEqual({ depth: 2, text: "Usage" });

      // Members list
      expect(result.payload?.members).toEqual(["readme-chunk-0", "readme-chunk-1", "readme-chunk-2"]);

      // Aggregated stats
      expect(result.payload?.chunkCount).toBe(3);
      expect(result.payload?.contentSize).toBe(
        "# Getting Started\n\nSome intro text.".length +
          "## Installation\n\nRun npm install.".length +
          "## Usage\n\nImport and call.".length,
      );

      // Git stripped to file-level
      expect(result.payload?.git).toEqual({ file: { commitCount: 5, ageDays: 60 } });

      // Line range spans all chunks
      expect(result.payload?.startLine).toBe(1);
      expect(result.payload?.endLine).toBe(30);
    });

    it("deduplicates consecutive headings from overlapping headingPaths", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "d-1",
          payload: {
            symbolId: "chunk-0",
            parentSymbolId: "doc-hash",
            relativePath: "docs/api.md",
            language: "markdown",
            isDocumentation: true,
            content: "API section content",
            startLine: 1,
            endLine: 10,
            headingPath: [
              { depth: 1, text: "API Reference" },
              { depth: 2, text: "Methods" },
            ],
          },
        },
        {
          id: "d-2",
          payload: {
            symbolId: "chunk-1",
            parentSymbolId: "doc-hash",
            relativePath: "docs/api.md",
            language: "markdown",
            isDocumentation: true,
            content: "More methods content",
            startLine: 11,
            endLine: 20,
            // Same heading path — both under "API Reference > Methods"
            headingPath: [
              { depth: 1, text: "API Reference" },
              { depth: 2, text: "Methods" },
            ],
          },
        },
      ];

      const result = DocChunkGrouper.group(chunks);

      // Headings deduplicated: only 2 unique entries, not 4
      const hp = result.payload?.headingPath as { depth: number; text: string }[];
      expect(hp).toHaveLength(2);

      // TOC has only 2 lines
      const content = result.payload?.content as string;
      const lines = content.split("\n");
      expect(lines).toHaveLength(2);
      // First chunk introduces both headings
      expect(lines[0]).toBe("# API Reference  chunk-0");
      expect(lines[1]).toBe("  ## Methods  chunk-0");
    });

    it("handles chunks without headingPath", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "nh-1",
          payload: {
            symbolId: "no-heading-chunk",
            parentSymbolId: "doc-hash",
            relativePath: "docs/plain.md",
            language: "markdown",
            isDocumentation: true,
            content: "Plain text without headings.",
            startLine: 1,
            endLine: 5,
          },
        },
      ];

      const result = DocChunkGrouper.group(chunks);

      expect(result.payload?.headingPath).toEqual([]);
      expect(result.payload?.content).toBe("");
      expect(result.payload?.members).toEqual(["no-heading-chunk"]);
      expect(result.payload?.chunkCount).toBe(1);
    });
  });
});
