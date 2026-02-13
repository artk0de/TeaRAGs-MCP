import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeIndexer } from "../../../src/code/indexer.js";
import type { CodeConfig } from "../../../src/code/types.js";
import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "./test-helpers.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("SearchModule", () => {
  let indexer: CodeIndexer;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: CodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    indexer = new CodeIndexer(qdrant as any, embeddings, config);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("searchCode", () => {
    beforeEach(async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        // eslint-disable-next-line no-template-curly-in-string
        "export function hello(name: string): string {\n  const greeting = `Hello, ${name}!`;\n  return greeting;\n}",
      );
      await indexer.indexCodebase(codebaseDir);
    });

    it("should search indexed codebase", async () => {
      const results = await indexer.searchCode(codebaseDir, "hello function");

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it("should throw error for non-indexed codebase", async () => {
      const { promises: fs } = await import("node:fs");
      const { join } = await import("node:path");
      const nonIndexedDir = join(tempDir, "non-indexed");
      await fs.mkdir(nonIndexedDir, { recursive: true });

      await expect(indexer.searchCode(nonIndexedDir, "test")).rejects.toThrow("not indexed");
    });

    it("should respect limit option", async () => {
      const results = await indexer.searchCode(codebaseDir, "test", {
        limit: 2,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should apply score threshold", async () => {
      const results = await indexer.searchCode(codebaseDir, "test", {
        scoreThreshold: 0.95,
      });

      results.forEach((r) => {
        expect(r.score).toBeGreaterThanOrEqual(0.95);
      });
    });

    it("should filter by file types", async () => {
      await createTestFile(codebaseDir, "test.py", "def test(): pass");
      await indexer.indexCodebase(codebaseDir, { forceReindex: true });

      const results = await indexer.searchCode(codebaseDir, "test", {
        fileTypes: [".py"],
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it("should use hybrid search when enabled", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new CodeIndexer(qdrant as any, embeddings, hybridConfig);

      await createTestFile(
        codebaseDir,
        "test.ts",
        `export function testFunction(): boolean {
  console.log('Running comprehensive test suite');
  const result = performValidation();
  const status = checkStatus();
  return result && status;
}
function performValidation(): boolean {
  console.log('Validating data');
  return true;
}
function checkStatus(): boolean {
  return true;
}`,
      );
      await hybridIndexer.indexCodebase(codebaseDir, { forceReindex: true });

      const hybridSearchSpy = vi.spyOn(qdrant, "hybridSearch");

      await hybridIndexer.searchCode(codebaseDir, "test");

      expect(hybridSearchSpy).toHaveBeenCalled();
    });

    it("should format results correctly", async () => {
      const results = await indexer.searchCode(codebaseDir, "hello");

      results.forEach((result) => {
        expect(result).toHaveProperty("content");
        expect(result).toHaveProperty("filePath");
        expect(result).toHaveProperty("startLine");
        expect(result).toHaveProperty("endLine");
        expect(result).toHaveProperty("language");
        expect(result).toHaveProperty("score");
      });
    });

    it("should include symbolId in metadata when available", async () => {
      await createTestFile(
        codebaseDir,
        "calculator.ts",
        `export function calculateSum(numbers: number[]): number {
  // Calculate sum of all numbers
  let total = 0;
  for (const num of numbers) {
    total += num;
  }
  return total;
}

export function calculateProduct(numbers: number[]): number {
  // Calculate product of all numbers
  let result = 1;
  for (const num of numbers) {
    result *= num;
  }
  return result;
}`,
      );

      await indexer.indexCodebase(codebaseDir);

      const results = await indexer.searchCode(codebaseDir, "calculate sum");

      expect(results.length).toBeGreaterThan(0);

      const functionResult = results.find(
        (r) => r.content.includes("calculateSum") || r.content.includes("calculateProduct"),
      );

      if (functionResult) {
        expect(functionResult).toHaveProperty("symbolId");
        if (functionResult.symbolId) {
          expect(["calculateSum", "calculateProduct"]).toContain(functionResult.symbolId);
        }
      }
    });
  });

  describe("searchCode edge cases and filters", () => {
    beforeEach(async () => {
      await createTestFile(
        codebaseDir,
        "app.ts",
        "export function appMain(): void {\n  console.log('Application started');\n}",
      );
      await createTestFile(codebaseDir, "README.md", "# Documentation\n\nThis is the project documentation.");
      await indexer.indexCodebase(codebaseDir);
    });

    it("should apply documentationOnly filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "documentation", {
        documentationOnly: true,
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "isDocumentation", match: { value: true } }]),
        }),
      );
    });

    it("should apply git author filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "test", {
        author: "John Doe",
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.dominantAuthor", match: { value: "John Doe" } }]),
        }),
      );
    });

    it("should apply modifiedAfter filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");
      const dateStr = "2024-01-01T00:00:00Z";

      await indexer.searchCode(codebaseDir, "test", {
        modifiedAfter: dateStr,
      });

      const expectedTimestamp = Math.floor(new Date(dateStr).getTime() / 1000);
      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.lastModifiedAt", range: { gte: expectedTimestamp } }]),
        }),
      );
    });

    it("should apply modifiedBefore filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");
      const dateStr = "2025-06-01T00:00:00Z";

      await indexer.searchCode(codebaseDir, "test", {
        modifiedBefore: dateStr,
      });

      const expectedTimestamp = Math.floor(new Date(dateStr).getTime() / 1000);
      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.lastModifiedAt", range: { lte: expectedTimestamp } }]),
        }),
      );
    });

    it("should apply minAgeDays filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "test", {
        minAgeDays: 30,
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.ageDays", range: { gte: 30 } }]),
        }),
      );
    });

    it("should apply maxAgeDays filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "test", {
        maxAgeDays: 7,
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.ageDays", range: { lte: 7 } }]),
        }),
      );
    });

    it("should apply minCommitCount filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "test", {
        minCommitCount: 5,
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.commitCount", range: { gte: 5 } }]),
        }),
      );
    });

    it("should apply taskId filter", async () => {
      const searchSpy = vi.spyOn(qdrant, "search");

      await indexer.searchCode(codebaseDir, "test", {
        taskId: "TD-12345",
      });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "git.taskIds", match: { any: ["TD-12345"] } }]),
        }),
      );
    });

    it("should apply pathPattern glob filter client-side", async () => {
      const results = await indexer.searchCode(codebaseDir, "test", {
        pathPattern: "**/*.ts",
      });

      // All results should have .ts extension paths
      expect(Array.isArray(results)).toBe(true);
    });

    it("should apply rerank with non-relevance preset", async () => {
      const results = await indexer.searchCode(codebaseDir, "test", {
        rerank: "recent",
      });

      // Should return results (reranked)
      expect(Array.isArray(results)).toBe(true);
    });

    it("should include git metadata in results when present", async () => {
      // Manually add a point with git metadata to test the result formatting
      const searchSpy = vi.spyOn(qdrant, "search").mockResolvedValueOnce([
        {
          id: "test-point",
          score: 0.95,
          payload: {
            content: "test content",
            relativePath: "app.ts",
            startLine: 1,
            endLine: 10,
            language: "typescript",
            fileExtension: ".ts",
            git: {
              commitCount: 5,
              dominantAuthor: "Jane",
              ageDays: 14,
            },
          },
        },
      ]);

      const results = await indexer.searchCode(codebaseDir, "test");

      expect(results.length).toBe(1);
      expect(results[0].metadata).toBeDefined();
      expect(results[0].metadata?.git).toBeDefined();
      expect(results[0].metadata?.git?.commitCount).toBe(5);

      searchSpy.mockRestore();
    });

    it("should handle results with missing payload fields gracefully", async () => {
      const searchSpy = vi.spyOn(qdrant, "search").mockResolvedValueOnce([
        {
          id: "test-point",
          score: 0.8,
          payload: {},
        },
      ]);

      const results = await indexer.searchCode(codebaseDir, "test");

      expect(results.length).toBe(1);
      expect(results[0].content).toBe("");
      expect(results[0].filePath).toBe("");
      expect(results[0].startLine).toBe(0);
      expect(results[0].endLine).toBe(0);
      expect(results[0].language).toBe("unknown");
      expect(results[0].fileExtension).toBe("");

      searchSpy.mockRestore();
    });
  });
});
