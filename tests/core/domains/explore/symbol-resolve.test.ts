import { describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

describe("resolveSymbols", () => {
  describe("function merge strategy", () => {
    it("merges multiple chunks of the same function into one result", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "function processData(input: string) {\n  const parsed = parse(input);",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "  return transform(parsed);\n}",
            startLine: 21,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("uuid-1");
      expect(results[0].score).toBe(1.0);
      expect(results[0].payload?.symbolId).toBe("processData");
      expect(results[0].payload?.startLine).toBe(10);
      expect(results[0].payload?.endLine).toBe(25);
      expect(results[0].payload?.mergedChunkIds).toEqual(["uuid-1", "uuid-2"]);
      expect(results[0].payload?.content).toContain("function processData");
      expect(results[0].payload?.content).toContain("return transform");
      expect(results[0].payload?.git).toEqual({ file: { commitCount: 5, ageDays: 30 } });
    });

    it("returns single chunk as-is without mergedChunkIds", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "simpleFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function simpleFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 10 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.mergedChunkIds).toBeUndefined();
    });

    it("strips content when metaOnly is true", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "myFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function myFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 5 } },
          },
        },
      ];

      const results = resolveSymbols(chunks, undefined, true);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBeUndefined();
      expect(results[0].payload?.symbolId).toBe("myFunc");
      expect(results[0].payload?.relativePath).toBe("src/utils.ts");
      expect(results[0].payload?.git).toBeDefined();
    });
  });

  describe("class outline strategy", () => {
    it("returns class chunk with members list", () => {
      const chunks = [
        {
          id: "class-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {\n  constructor(deps: Deps) {}",
            startLine: 10,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-1",
          payload: {
            symbolId: "Reranker.score",
            chunkType: "function",
            parentName: "Reranker",
            relativePath: "src/reranker.ts",
            content: "score() { ... }",
            startLine: 30,
            endLine: 50,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-2",
          payload: {
            symbolId: "Reranker.rerank",
            chunkType: "function",
            parentName: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 55,
            endLine: 80,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.chunkType === "class");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.members).toEqual(["Reranker.score", "Reranker.rerank"]);
      expect(classResult!.payload?.git).toEqual({ file: { commitCount: 15, ageDays: 60 } });
    });

    it("detects class from residual block with parentType=class_declaration", () => {
      const chunks = [
        {
          id: "residual-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "block",
            parentType: "class_declaration",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "export class Reranker {\n  private readonly descriptors;",
            startLine: 43,
            endLine: 46,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
        {
          id: "method-uuid",
          payload: {
            symbolId: "Reranker.rerank",
            chunkType: "function",
            parentName: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 76,
            endLine: 151,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.symbolId === "Reranker");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.members).toEqual(["Reranker.rerank"]);
    });
  });

  describe("sorting", () => {
    it("sorts exact symbolId matches before partial matches", () => {
      const chunks = [
        {
          id: "uuid-partial",
          payload: {
            symbolId: "Reranker.score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 30,
            endLine: 50,
            language: "typescript",
          },
        },
        {
          id: "uuid-exact",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "Reranker");

      expect(results[0].payload?.symbolId).toBe("Reranker");
    });

    it("sorts alphabetically by path for same match rank", () => {
      const chunks = [
        {
          id: "uuid-b",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/b/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-a",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/a/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "score");

      expect(results[0].payload?.relativePath).toBe("src/a/scorer.ts");
    });
  });

  describe("mixed results", () => {
    it("handles functions from different files separately", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/auth.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/input.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "validate");

      expect(results).toHaveLength(2);
    });
  });
});
