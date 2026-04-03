import { describe, expect, it } from "vitest";

import { CodeChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/code.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";

describe("CodeChunkGrouper", () => {
  describe("group (class outline)", () => {
    it("builds outline with instance (#) and static (.) members sorted by startLine", () => {
      const classChunk: ScrollChunk = {
        id: "class-1",
        payload: {
          name: "Reranker",
          symbolId: "Reranker",
          chunkType: "class",
          relativePath: "src/reranker.ts",
          content: "class Reranker { ... }",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { commitCount: 10, ageDays: 30 },
            chunk: { commitCount: 3, ageDays: 5 },
          },
        },
      };

      const memberChunks: ScrollChunk[] = [
        {
          id: "m-3",
          payload: {
            symbolId: "Reranker.create",
            name: "create",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "static create() { ... }",
            startLine: 40,
            endLine: 45,
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "m-1",
          payload: {
            symbolId: "Reranker#rerank",
            name: "rerank",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "rerank(results) { ... }",
            startLine: 10,
            endLine: 20,
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "m-2",
          payload: {
            symbolId: "Reranker#score",
            name: "score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score(item) { ... }",
            startLine: 25,
            endLine: 35,
            parentSymbolId: "Reranker",
          },
        },
      ];

      const result = CodeChunkGrouper.group(classChunk, memberChunks);

      expect(result.id).toBe("class-1");
      expect(result.score).toBe(1.0);

      // Synthetic outline content (members visible in outline, no separate members array)
      const content = result.payload?.content as string;
      expect(content).toBe("Reranker\n  Reranker#rerank\n  Reranker#score\n  Reranker.create");

      // Git stripped to file-level only
      expect(result.payload?.git).toEqual({ file: { commitCount: 10, ageDays: 30 } });
      expect((result.payload?.git as Record<string, unknown>).chunk).toBeUndefined();

      // Aggregated stats
      expect(result.payload?.chunkCount).toBe(4); // 1 class + 3 members
      expect(result.payload?.contentSize).toBe(
        "class Reranker { ... }".length +
          "rerank(results) { ... }".length +
          "score(item) { ... }".length +
          "static create() { ... }".length,
      );
    });

    it("handles class with no members", () => {
      const classChunk: ScrollChunk = {
        id: "class-empty",
        payload: {
          name: "EmptyClass",
          symbolId: "EmptyClass",
          chunkType: "class",
          relativePath: "src/empty.ts",
          content: "class EmptyClass {}",
          startLine: 1,
          endLine: 1,
          language: "typescript",
        },
      };

      const result = CodeChunkGrouper.group(classChunk, []);

      expect(result.payload?.content).toBe("EmptyClass");
      expect(result.payload?.chunkCount).toBe(1);
      expect(result.payload?.contentSize).toBe("class EmptyClass {}".length);
      expect(result.payload?.git).toBeUndefined();
    });
  });

  describe("groupFile (file-level outline)", () => {
    it("builds hierarchy with top-level symbols and nested members", () => {
      const chunks: ScrollChunk[] = [
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
            git: {
              file: { commitCount: 10 },
              chunk: { commitCount: 2 },
            },
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
            name: "score",
            symbolId: "Reranker#score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 25,
            endLine: 35,
            language: "typescript",
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "c-4",
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
        {
          id: "c-5",
          payload: {
            name: "DEFAULTS",
            symbolId: "DEFAULTS",
            chunkType: "block",
            relativePath: "src/reranker.ts",
            content: "const DEFAULTS = {}",
            startLine: 1,
            endLine: 3,
            language: "typescript",
            git: {
              file: { commitCount: 10 },
            },
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.id).toBe("c-5"); // first by startLine (DEFAULTS at line 1)
      expect(result.score).toBe(1.0);

      const content = result.payload?.content as string;
      const lines = content.split("\n");
      expect(lines[0]).toBe("src/reranker.ts");
      expect(lines[1]).toBe("  DEFAULTS");
      expect(lines[2]).toBe("  Reranker");
      expect(lines[3]).toBe("    Reranker#rerank");
      expect(lines[4]).toBe("    Reranker#score");
      expect(lines[5]).toBe("  createReranker");

      expect(result.payload?.relativePath).toBe("src/reranker.ts");
      expect(result.payload?.language).toBe("typescript");
      expect(result.payload?.chunkCount).toBe(5);
      expect(result.payload?.git).toEqual({ file: { commitCount: 10 } });
    });

    it("handles file with only top-level symbols (no nesting)", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "f-1",
          payload: {
            name: "helperA",
            symbolId: "helperA",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function helperA() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "f-2",
          payload: {
            name: "helperB",
            symbolId: "helperB",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function helperB() {}",
            startLine: 10,
            endLine: 15,
            language: "typescript",
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      const content = result.payload?.content as string;
      expect(content).toBe("src/utils.ts\n  helperA\n  helperB");
      expect(result.payload?.chunkCount).toBe(2);
    });
  });
});
