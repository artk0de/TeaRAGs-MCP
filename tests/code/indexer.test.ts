import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Mock tree-sitter modules to prevent native binding crashes
// Note: vi.mock() is hoisted, so all values must be inline (no external references)
import { vi } from "vitest";

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

import { CodeIndexer } from "../../src/code/indexer.js";
import type { CodeConfig } from "../../src/code/types.js";
import {
  MockQdrantManager,
  MockEmbeddingProvider,
  createTestFile,
  defaultTestConfig,
  createTempTestDir,
  cleanupTempDir,
} from "./indexer/test-helpers.js";

describe("CodeIndexer", () => {
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

  describe("path validation", () => {
    it("should handle non-existent paths gracefully", async () => {
      // Create a path that doesn't exist yet
      const nonExistentDir = join(codebaseDir, "non-existent-dir");

      // Should not throw error, validatePath falls back to absolute path
      // and scanner finds 0 files
      const stats = await indexer.indexCodebase(nonExistentDir);
      expect(stats.filesScanned).toBe(0);
      expect(stats.status).toBe("completed");
    });

    it("should resolve real paths for existing directories", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const test = true;");

      // Should successfully index with real path
      const stats = await indexer.indexCodebase(codebaseDir);
      expect(stats.filesScanned).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle nested directory structures", async () => {
      await fs.mkdir(join(codebaseDir, "src", "components"), {
        recursive: true,
      });
      await createTestFile(
        codebaseDir,
        "src/components/Button.ts",
        `export const Button = () => {
  console.log('Button component rendering');
  const handleClick = () => {
    console.log('Button clicked');
  };
  return '<button>Click me</button>';
}`,
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesIndexed).toBe(1);
    });

    it("should handle files with unicode content", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "const greeting = '你好世界';",
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.status).toBe("completed");
    });

    it("should handle very large files", async () => {
      const largeContent = "function test() {}\n".repeat(1000);
      await createTestFile(codebaseDir, "large.ts", largeContent);

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.chunksCreated).toBeGreaterThan(1);
    });

    it("should generate consistent collection names", async () => {
      await createTestFile(codebaseDir, "test.ts", "const x = 1;");

      await indexer.indexCodebase(codebaseDir);
      const status1 = await indexer.getIndexStatus(codebaseDir);

      await indexer.clearIndex(codebaseDir);

      await indexer.indexCodebase(codebaseDir);
      const status2 = await indexer.getIndexStatus(codebaseDir);

      expect(status1.collectionName).toBe(status2.collectionName);
    });

    it("should handle concurrent operations gracefully", async () => {
      await createTestFile(codebaseDir, "test.ts", "const x = 1;");

      await indexer.indexCodebase(codebaseDir);

      const searchPromises = [
        indexer.searchCode(codebaseDir, "test"),
        indexer.searchCode(codebaseDir, "const"),
        indexer.getIndexStatus(codebaseDir),
      ];

      const results = await Promise.all(searchPromises);

      expect(results).toHaveLength(3);
    });
  });
});
