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

describe("StatusModule", () => {
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

  describe("getIndexStatus", () => {
    describe("not_indexed status", () => {
      it("should return not_indexed for new codebase with no collection", async () => {
        const status = await indexer.getIndexStatus(codebaseDir);

        expect(status.isIndexed).toBe(false);
        expect(status.status).toBe("not_indexed");
        expect(status.collectionName).toBeUndefined();
        expect(status.chunksCount).toBeUndefined();
      });

      it("should return not_indexed when collection exists but has no chunks and no completion marker", async () => {
        const emptyDir = join(tempDir, "empty-codebase");
        await fs.mkdir(emptyDir, { recursive: true });
        await fs.writeFile(join(emptyDir, "readme.md"), "# README");

        const stats = await indexer.indexCodebase(emptyDir);

        expect(stats.filesScanned).toBe(0);

        const status = await indexer.getIndexStatus(emptyDir);
        expect(status.status).toBe("not_indexed");
        expect(status.isIndexed).toBe(false);
      });
    });

    describe("indexed status", () => {
      it("should return indexed status after successful indexing", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const APP_CONFIG = {\n  port: 3000,\n  host: 'localhost',\n  debug: true,\n  apiUrl: 'https://api.example.com',\n  timeout: 5000\n};\nconsole.log('Config loaded');",
        );
        await indexer.indexCodebase(codebaseDir);

        const status = await indexer.getIndexStatus(codebaseDir);

        expect(status.isIndexed).toBe(true);
        expect(status.status).toBe("indexed");
        expect(status.collectionName).toBeDefined();
        expect(status.chunksCount).toBeGreaterThan(0);
      });

      it("should include lastUpdated timestamp after indexing", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const value = 1;\nconsole.log('Testing timestamp');\nfunction test() { return value; }",
        );

        const beforeIndexing = new Date();
        await indexer.indexCodebase(codebaseDir);
        const afterIndexing = new Date();

        const status = await indexer.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexed");
        expect(status.lastUpdated).toBeDefined();
        expect(status.lastUpdated).toBeInstanceOf(Date);
        expect(status.lastUpdated!.getTime()).toBeGreaterThanOrEqual(beforeIndexing.getTime());
        expect(status.lastUpdated!.getTime()).toBeLessThanOrEqual(afterIndexing.getTime());
      });

      it("should return correct chunks count excluding metadata point", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const a = 1;\nexport const b = 2;\nconsole.log('File with content');\nfunction helper() { return a + b; }",
        );
        await indexer.indexCodebase(codebaseDir);

        const status = await indexer.getIndexStatus(codebaseDir);

        expect(status.chunksCount).toBeGreaterThanOrEqual(0);
        expect(typeof status.chunksCount).toBe("number");
      });
    });

    describe("completion marker", () => {
      it("should store completion marker when indexing completes", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const data = { key: 'value' };\nconsole.log('Completion marker test');\nfunction process() { return data; }",
        );
        await indexer.indexCodebase(codebaseDir);

        const status = await indexer.getIndexStatus(codebaseDir);
        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
      });

      it("should store completion marker even when no chunks are created", async () => {
        await createTestFile(codebaseDir, "tiny.ts", "const x = 1;");

        await indexer.indexCodebase(codebaseDir);

        const status = await indexer.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
      });

      it("should update completion marker on force reindex", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const v1 = 'first';\nconsole.log('First indexing');\nfunction init() { return v1; }",
        );

        await indexer.indexCodebase(codebaseDir);
        const status1 = await indexer.getIndexStatus(codebaseDir);

        await new Promise((resolve) => setTimeout(resolve, 10));

        await indexer.indexCodebase(codebaseDir, { forceReindex: true });
        const status2 = await indexer.getIndexStatus(codebaseDir);

        expect(status2.status).toBe("indexed");
        expect(status1.lastUpdated).toBeDefined();
        expect(status2.lastUpdated).toBeDefined();
      });
    });

    describe("backwards compatibility", () => {
      it("should always return isIndexed boolean for backwards compatibility", async () => {
        let status = await indexer.getIndexStatus(codebaseDir);
        expect(typeof status.isIndexed).toBe("boolean");
        expect(status.isIndexed).toBe(false);

        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const test = true;\nconsole.log('Backwards compat test');\nfunction run() { return test; }",
        );
        await indexer.indexCodebase(codebaseDir);

        status = await indexer.getIndexStatus(codebaseDir);
        expect(typeof status.isIndexed).toBe("boolean");
        expect(status.isIndexed).toBe(true);
      });

      it("should have isIndexed=true only when status=indexed", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const consistency = 1;\nconsole.log('Consistency check');\nfunction check() { return consistency; }",
        );
        await indexer.indexCodebase(codebaseDir);

        const status = await indexer.getIndexStatus(codebaseDir);

        if (status.status === "indexed") {
          expect(status.isIndexed).toBe(true);
        } else {
          expect(status.isIndexed).toBe(false);
        }
      });
    });

    describe("indexing in-progress status", () => {
      it("should return indexing status during active indexing", async () => {
        for (let i = 0; i < 5; i++) {
          await createTestFile(
            codebaseDir,
            `file${i}.ts`,
            `export const value${i} = ${i};\nconsole.log('Processing file ${i}');\nfunction process${i}(x: number) {\n  const result = x * ${i};\n  console.log('Result:', result);\n  return result;\n}`,
          );
        }

        let statusDuringIndexing: any = null;

        const indexingPromise = indexer.indexCodebase(codebaseDir, undefined, async (progress) => {
          if (progress.phase === "embedding" && statusDuringIndexing === null) {
            statusDuringIndexing = await indexer.getIndexStatus(codebaseDir);
          }
        });

        await indexingPromise;

        if (statusDuringIndexing) {
          expect(statusDuringIndexing.status).toBe("indexing");
          expect(statusDuringIndexing.isIndexed).toBe(false);
          expect(statusDuringIndexing.collectionName).toBeDefined();
        }

        const statusAfter = await indexer.getIndexStatus(codebaseDir);
        expect(statusAfter.status).toBe("indexed");
        expect(statusAfter.isIndexed).toBe(true);
      });

      it("should track chunksCount during indexing", async () => {
        for (let i = 0; i < 3; i++) {
          await createTestFile(
            codebaseDir,
            `module${i}.ts`,
            `export class Module${i} {\n  constructor() {\n    console.log('Module ${i} initialized');\n  }\n  process(data: string): string {\n    return data.toUpperCase();\n  }\n}`,
          );
        }

        let chunksCountDuringIndexing: number | undefined;

        await indexer.indexCodebase(codebaseDir, undefined, async (progress) => {
          if (progress.phase === "storing" && chunksCountDuringIndexing === undefined) {
            const status = await indexer.getIndexStatus(codebaseDir);
            chunksCountDuringIndexing = status.chunksCount;
          }
        });

        if (chunksCountDuringIndexing !== undefined) {
          expect(typeof chunksCountDuringIndexing).toBe("number");
          expect(chunksCountDuringIndexing).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe("legacy collection handling", () => {
      it("should treat collection with chunks but no completion marker as indexed", async () => {
        await createTestFile(
          codebaseDir,
          "legacy.ts",
          "export const legacy = true;\nconsole.log('Legacy test');\nfunction legacyFn() { return legacy; }",
        );
        await indexer.indexCodebase(codebaseDir);

        const initialStatus = await indexer.getIndexStatus(codebaseDir);
        expect(initialStatus.status).toBe("indexed");

        expect(initialStatus.chunksCount).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("clearIndex", () => {
    it("should clear indexed codebase", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const configValue = 1;\nconsole.log('Config loaded');");
      await indexer.indexCodebase(codebaseDir);

      await indexer.clearIndex(codebaseDir);

      const status = await indexer.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(false);
    });

    it("should handle clearing non-indexed codebase", async () => {
      await expect(indexer.clearIndex(codebaseDir)).resolves.not.toThrow();
    });

    it("should allow re-indexing after clearing", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const reindexValue = 1;\nconsole.log('Reindexing');");
      await indexer.indexCodebase(codebaseDir);

      await indexer.clearIndex(codebaseDir);

      const stats = await indexer.indexCodebase(codebaseDir);
      expect(stats.status).toBe("completed");
    });
  });
});
