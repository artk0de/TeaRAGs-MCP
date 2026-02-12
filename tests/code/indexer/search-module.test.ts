import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { CodeIndexer } from "../../../src/code/indexer.js";
import type { CodeConfig } from "../../../src/code/types.js";
import {
  MockQdrantManager,
  MockEmbeddingProvider,
  createTestFile,
  defaultTestConfig,
  createTempTestDir,
  cleanupTempDir,
} from "./test-helpers.js";

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

      await expect(indexer.searchCode(nonIndexedDir, "test")).rejects.toThrow(
        "not indexed",
      );
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
      const hybridIndexer = new CodeIndexer(
        qdrant as any,
        embeddings,
        hybridConfig,
      );

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

      const functionResult = results.find(r =>
        r.content.includes("calculateSum") || r.content.includes("calculateProduct")
      );

      if (functionResult) {
        expect(functionResult).toHaveProperty("symbolId");
        if (functionResult.symbolId) {
          expect(["calculateSum", "calculateProduct"]).toContain(
            functionResult.symbolId
          );
        }
      }
    });
  });
});
