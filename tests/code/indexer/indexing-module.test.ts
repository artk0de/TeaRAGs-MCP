import { promises as fs } from "node:fs";
import { join } from "node:path";

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

describe("IndexingModule", () => {
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

  describe("indexCodebase", () => {
    it("should index a simple codebase", async () => {
      await createTestFile(
        codebaseDir,
        "hello.ts",
        'export function hello(name: string): string {\n  console.log("Greeting user");\n  return `Hello, ${name}!`;\n}',
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(1);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.chunksCreated).toBeGreaterThan(0);
      expect(stats.status).toBe("completed");
    });

    it("should handle empty directory", async () => {
      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(0);
      expect(stats.chunksCreated).toBe(0);
      expect(stats.status).toBe("completed");
    });

    it("should index multiple files", async () => {
      await createTestFile(codebaseDir, "file1.ts", "function test1() {}");
      await createTestFile(codebaseDir, "file2.js", "function test2() {}");
      await createTestFile(codebaseDir, "file3.py", "def test3(): pass");

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(3);
      expect(stats.filesIndexed).toBe(3);
    });

    it("should create collection with correct settings", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const configuration = {\n  apiKey: process.env.API_KEY,\n  timeout: 5000\n};",
      );

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");

      await indexer.indexCodebase(codebaseDir);

      expect(createCollectionSpy).toHaveBeenCalledWith(expect.stringContaining("code_"), 384, "Cosine", false);
    });

    it("should force re-index when option is set", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function calculateTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}",
      );

      await indexer.indexCodebase(codebaseDir);
      const deleteCollectionSpy = vi.spyOn(qdrant, "deleteCollection");

      await indexer.indexCodebase(codebaseDir, { forceReindex: true });

      expect(deleteCollectionSpy).toHaveBeenCalled();
    });

    it("should call progress callback", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export interface User {\n  id: string;\n  name: string;\n  email: string;\n}",
      );

      const progressCallback = vi.fn();

      await indexer.indexCodebase(codebaseDir, undefined, progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      expect(progressCallback.mock.calls.some((call) => call[0].phase === "scanning")).toBe(true);
      expect(progressCallback.mock.calls.some((call) => call[0].phase === "chunking")).toBe(true);
    });

    it("should respect custom extensions", async () => {
      await createTestFile(codebaseDir, "test.ts", "const x = 1;");
      await createTestFile(codebaseDir, "test.md", "# Documentation");

      const stats = await indexer.indexCodebase(codebaseDir, {
        extensions: [".md"],
      });

      expect(stats.filesScanned).toBe(1);
    });

    it("should handle files with secrets gracefully", async () => {
      await createTestFile(codebaseDir, "secrets.ts", 'const apiKey = "sk_test_FAKE_KEY_FOR_TESTING_ONLY_NOT_REAL";');

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.errors).toBeDefined();
      expect(stats.errors?.some((e) => e.includes("secrets"))).toBe(true);
    });

    it("should enable hybrid search when configured", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new CodeIndexer(qdrant as any, embeddings, hybridConfig);

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export class DataService {\n  async fetchData(): Promise<any[]> {\n    return [];\n  }\n}",
      );

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");

      await hybridIndexer.indexCodebase(codebaseDir);

      expect(createCollectionSpy).toHaveBeenCalledWith(expect.stringContaining("code_"), 384, "Cosine", true);
    });

    it("should handle file read errors", async () => {
      await createTestFile(codebaseDir, "test.ts", "content");

      const originalReadFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (path: any, ...args: any[]) => {
        if (path.includes("test.ts")) {
          throw new Error("Permission denied");
        }
        return originalReadFile(path, ...args);
      });

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.errors?.some((e) => e.includes("Permission denied"))).toBe(true);

      vi.restoreAllMocks();
    });

    it("should batch embed operations", async () => {
      for (let i = 0; i < 5; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export function test${i}() {\n  console.log('Test function ${i}');\n  const value = ${i};\n  const result = value * 2;\n  return result;\n}\n\nexport const config${i} = { enabled: true };`,
        );
      }

      const embedBatchSpy = vi.spyOn(embeddings, "embedBatch");

      await indexer.indexCodebase(codebaseDir);

      expect(embedBatchSpy).toHaveBeenCalled();
    });
  });

  describe("Chunk limiting configuration", () => {
    it("should respect maxChunksPerFile limit", async () => {
      const limitedConfig = {
        ...config,
        maxChunksPerFile: 2,
      };
      const limitedIndexer = new CodeIndexer(qdrant as any, embeddings, limitedConfig);

      const largeContent = Array(50)
        .fill(null)
        .map((_, i) => `function test${i}() { console.log('test ${i}'); return ${i}; }`)
        .join("\n\n");

      await createTestFile(codebaseDir, "large.ts", largeContent);

      const stats = await limitedIndexer.indexCodebase(codebaseDir);

      expect(stats.chunksCreated).toBeLessThanOrEqual(2);
      expect(stats.filesIndexed).toBe(1);
    });

    it("should respect maxTotalChunks limit", async () => {
      const limitedConfig = {
        ...config,
        maxTotalChunks: 3,
      };
      const limitedIndexer = new CodeIndexer(qdrant as any, embeddings, limitedConfig);

      for (let i = 0; i < 10; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export function func${i}() { console.log('function ${i}'); return ${i}; }`,
        );
      }

      const stats = await limitedIndexer.indexCodebase(codebaseDir);

      expect(stats.chunksCreated).toBeLessThanOrEqual(3);
      expect(stats.filesIndexed).toBeGreaterThan(0);
    });

    it("should handle maxTotalChunks during chunk iteration", async () => {
      const limitedConfig = {
        ...config,
        maxTotalChunks: 1,
      };
      const limitedIndexer = new CodeIndexer(qdrant as any, embeddings, limitedConfig);

      const content = `
function first() {
  console.log('first function');
  return 1;
}

function second() {
  console.log('second function');
  return 2;
}

function third() {
  console.log('third function');
  return 3;
}
      `;

      await createTestFile(codebaseDir, "multi.ts", content);

      const stats = await limitedIndexer.indexCodebase(codebaseDir);

      expect(stats.chunksCreated).toBe(1);
    });
  });

  describe("Error handling edge cases", () => {
    it("should handle non-Error exceptions", async () => {
      await createTestFile(codebaseDir, "test.ts", "const x = 1;");

      const originalReadFile = fs.readFile;
      let callCount = 0;

      // @ts-expect-error - Mocking for test
      fs.readFile = async (path: any, encoding: any) => {
        callCount++;
        if (callCount === 1 && typeof path === "string" && path.endsWith("test.ts")) {
          throw "String error";
        }
        return originalReadFile(path, encoding);
      };

      try {
        const stats = await indexer.indexCodebase(codebaseDir);

        expect(stats.status).toBe("completed");
        expect(stats.errors?.some((e) => e.includes("String error"))).toBe(true);
      } finally {
        fs.readFile = originalReadFile;
      }
    });
  });
});
