import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaUnavailableError } from "../../../../src/core/adapters/embeddings/ollama/errors.js";
import { IngestFacade } from "../../../../src/core/api/index.js";
import { IndexingFailedError } from "../../../../src/core/domains/ingest/errors.js";
import type { IngestCodeConfig } from "../../../../src/core/types.js";
import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "./__helpers__/test-helpers.js";

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

describe("IndexPipeline", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("indexCodebase", () => {
    it("should index a simple codebase", async () => {
      await createTestFile(
        codebaseDir,
        "hello.ts",
        // eslint-disable-next-line no-template-curly-in-string
        'export function hello(name: string): string {\n  console.log("Greeting user");\n  return `Hello, ${name}!`;\n}',
      );

      const stats = await ingest.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(1);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.chunksCreated).toBeGreaterThan(0);
      expect(stats.status).toBe("completed");
    });

    it("should handle empty directory", async () => {
      const stats = await ingest.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(0);
      expect(stats.chunksCreated).toBe(0);
      expect(stats.status).toBe("completed");
    });

    it("should fallback to incremental reindex when collection exists without forceReindex", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const x = 1;");
      await ingest.indexCodebase(codebaseDir);

      // Second index without forceReindex → incremental reindex (no error)
      const stats = await ingest.indexCodebase(codebaseDir);
      expect(stats.status).toBe("completed");
      expect(stats.errors?.length ?? 0).toBe(0);
    });

    it("should index multiple files", async () => {
      await createTestFile(codebaseDir, "file1.ts", "function test1() {}");
      await createTestFile(codebaseDir, "file2.js", "function test2() {}");
      await createTestFile(codebaseDir, "file3.py", "def test3(): pass");

      const stats = await ingest.indexCodebase(codebaseDir);

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

      await ingest.indexCodebase(codebaseDir);

      expect(createCollectionSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        384,
        "Cosine",
        false,
        undefined,
      );
    });

    it("should use modelInfo dimensions for collection creation when available", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const x = 1;");

      // Add resolveModelInfo returning dimensions=768 (different from mock's 384)
      (embeddings as any).resolveModelInfo = vi.fn().mockResolvedValue({
        model: "nomic-embed-text",
        contextLength: 8192,
        dimensions: 768,
      });

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");

      await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      expect(createCollectionSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        768,
        "Cosine",
        false,
        undefined,
      );
    });

    it("should pass quantizationScalar to createCollection", async () => {
      config = { ...defaultTestConfig(), quantizationScalar: true };
      ingest = new IngestFacade({
        qdrant: qdrant as any,
        embeddings,
        config,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

      await createTestFile(codebaseDir, "test.ts", "export const x = 1;");

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");
      await ingest.indexCodebase(codebaseDir);

      expect(createCollectionSpy).toHaveBeenCalledWith(expect.stringContaining("code_"), 384, "Cosine", false, true);
    });

    it("should force re-index when option is set", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function calculateTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}",
      );

      await ingest.indexCodebase(codebaseDir);
      const deleteCollectionSpy = vi.spyOn(qdrant, "deleteCollection");

      await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      expect(deleteCollectionSpy).toHaveBeenCalled();
    });

    it("should call progress callback", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export interface User {\n  id: string;\n  name: string;\n  email: string;\n}",
      );

      const progressCallback = vi.fn();

      await ingest.indexCodebase(codebaseDir, undefined, progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      expect(progressCallback.mock.calls.some((call) => call[0].phase === "scanning")).toBe(true);
      expect(progressCallback.mock.calls.some((call) => call[0].phase === "chunking")).toBe(true);
    });

    it("should respect custom extensions", async () => {
      await createTestFile(codebaseDir, "test.ts", "const x = 1;");
      await createTestFile(codebaseDir, "test.md", "# Documentation");

      const stats = await ingest.indexCodebase(codebaseDir, {
        extensions: [".md"],
      });

      expect(stats.filesScanned).toBe(1);
    });

    it("should handle files with secrets gracefully", async () => {
      await createTestFile(codebaseDir, "secrets.ts", 'const apiKey = "sk_test_FAKE_KEY_FOR_TESTING_ONLY_NOT_REAL";');

      const stats = await ingest.indexCodebase(codebaseDir);

      expect(stats.errors).toBeDefined();
      expect(stats.errors?.some((e) => e.includes("secrets"))).toBe(true);
    });

    it("should enable hybrid search when configured", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new IngestFacade({
        qdrant: qdrant as any,
        embeddings,
        config: hybridConfig,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

      await createTestFile(
        codebaseDir,
        "test.ts",
        "export class DataService {\n  async fetchData(): Promise<any[]> {\n    return [];\n  }\n}",
      );

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");

      await hybridIndexer.indexCodebase(codebaseDir);

      expect(createCollectionSpy).toHaveBeenCalledWith(
        expect.stringContaining("code_"),
        384,
        "Cosine",
        true,
        undefined,
      );
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

      const stats = await ingest.indexCodebase(codebaseDir);

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

      await ingest.indexCodebase(codebaseDir);

      expect(embedBatchSpy).toHaveBeenCalled();
    });
  });

  describe("Chunk limiting configuration", () => {
    it("should respect maxChunksPerFile limit", async () => {
      const limitedConfig = {
        ...config,
        maxChunksPerFile: 2,
      };
      const limitedIndexer = new IngestFacade({
        qdrant: qdrant as any,
        embeddings,
        config: limitedConfig,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

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
      const limitedIndexer = new IngestFacade({
        qdrant: qdrant as any,
        embeddings,
        config: limitedConfig,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

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
      const limitedIndexer = new IngestFacade({
        qdrant: qdrant as any,
        embeddings,
        config: limitedConfig,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

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

  describe("Snapshot save failure", () => {
    it("should not fail indexing when snapshot save throws", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function snapshotTest(): string {\n  console.log('Testing snapshot failure');\n  return 'ok';\n}",
      );

      // First indexing succeeds and creates the collection
      await ingest.indexCodebase(codebaseDir);

      // Now force reindex with a broken synchronizer
      // We mock the ParallelFileSynchronizer's updateSnapshot to throw
      const { ParallelFileSynchronizer } =
        await import("../../../../src/core/domains/ingest/sync/parallel-synchronizer.js");
      const origUpdateSnapshot = ParallelFileSynchronizer.prototype.updateSnapshot;
      ParallelFileSynchronizer.prototype.updateSnapshot = async function () {
        throw new Error("Disk full: cannot save snapshot");
      };

      try {
        const stats = await ingest.indexCodebase(codebaseDir, { forceReindex: true });

        // Indexing should still complete successfully
        expect(stats.status).toBe("completed");
        // But the snapshot error should be recorded
        expect(stats.errors?.some((e) => e.includes("Snapshot save failed"))).toBe(true);
        expect(stats.errors?.some((e) => e.includes("Disk full"))).toBe(true);
      } finally {
        ParallelFileSynchronizer.prototype.updateSnapshot = origUpdateSnapshot;
      }
    });
  });

  describe("Overall indexing failure", () => {
    it("should throw IndexingFailedError when indexing encounters a fatal error", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function fatalTest(): number {\n  console.log('Testing fatal error');\n  return 42;\n}",
      );

      // Make createCollection throw to trigger the outer catch block
      vi.spyOn(qdrant, "createCollection").mockImplementation(async () => {
        throw new Error("Qdrant connection refused");
      });

      try {
        await expect(ingest.indexCodebase(codebaseDir)).rejects.toThrow(IndexingFailedError);
      } finally {
        vi.restoreAllMocks();
      }
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
          throw new Error("String error");
        }
        return originalReadFile(path, encoding);
      };

      try {
        const stats = await ingest.indexCodebase(codebaseDir);

        expect(stats.status).toBe("completed");
        expect(stats.errors?.some((e) => e.includes("String error"))).toBe(true);
      } finally {
        fs.readFile = originalReadFile;
      }
    });
  });

  describe("Versioned collections with aliases", () => {
    it("should create _v1 collection and alias on first index", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const x = 1;");

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");
      const createAliasSpy = vi.spyOn(qdrant.aliases, "createAlias");

      const stats = await ingest.indexCodebase(codebaseDir);

      expect(stats.status).toBe("completed");

      // Should create a versioned collection (_v1)
      const createCall = createCollectionSpy.mock.calls[0];
      expect(createCall[0]).toMatch(/_v1$/);

      // Should create alias pointing to _v1
      expect(createAliasSpy).toHaveBeenCalledTimes(1);
      const aliasCall = createAliasSpy.mock.calls[0];
      expect(aliasCall[0]).toMatch(/^code_/); // alias name = collection name
      expect(aliasCall[1]).toMatch(/_v1$/); // points to _v1
      expect(aliasCall[1]).toBe(createCall[0]); // alias points to created collection
    });

    it("should create _v2 and switch alias on forceReindex", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const x = 1;");

      // First index: creates _v1 + alias
      await ingest.indexCodebase(codebaseDir);

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");
      const switchAliasSpy = vi.spyOn(qdrant.aliases, "switchAlias");
      const deleteCollectionSpy = vi.spyOn(qdrant, "deleteCollection");

      // Force reindex: should create _v2, switch alias, delete _v1
      const stats = await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      expect(stats.status).toBe("completed");

      // Should create _v2
      const createCall = createCollectionSpy.mock.calls[0];
      expect(createCall[0]).toMatch(/_v2$/);

      // Should switch alias atomically
      expect(switchAliasSpy).toHaveBeenCalledTimes(1);
      const switchCall = switchAliasSpy.mock.calls[0];
      expect(switchCall[1]).toMatch(/_v1$/); // from _v1
      expect(switchCall[2]).toMatch(/_v2$/); // to _v2

      // Should delete old _v1
      expect(deleteCollectionSpy).toHaveBeenCalledWith(expect.stringMatching(/_v1$/));
    });

    it("should migrate real collection to alias scheme", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const y = 2;");

      // Simulate legacy: create a real collection (not via indexCodebase to avoid alias)
      const { resolveCollectionName, validatePath } =
        await import("../../../../src/core/domains/ingest/pipeline/../../../infra/collection-name.js");
      const absPath = await validatePath(codebaseDir);
      const collName = resolveCollectionName(absPath);
      await qdrant.createCollection(collName, 384, "Cosine");

      const createCollectionSpy = vi.spyOn(qdrant, "createCollection");
      const deleteCollectionSpy = vi.spyOn(qdrant, "deleteCollection");
      const createAliasSpy = vi.spyOn(qdrant.aliases, "createAlias");

      // Force reindex should detect migration
      const stats = await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      expect(stats.status).toBe("completed");

      // Should create _v2 (migration starts at v2)
      expect(createCollectionSpy).toHaveBeenCalledWith(expect.stringMatching(/_v2$/), 384, "Cosine", false, undefined);

      // Should delete real collection and create alias
      expect(deleteCollectionSpy).toHaveBeenCalledWith(collName);
      expect(createAliasSpy).toHaveBeenCalledWith(collName, expect.stringMatching(/_v2$/));
    });

    it("should throw IndexingFailedError on pipeline failure during forceReindex", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const z = 3;");

      // First index succeeds
      await ingest.indexCodebase(codebaseDir);

      // Make chunk pipeline fail during second indexing
      const origCreateCollection = qdrant.createCollection.bind(qdrant);
      let createCallCount = 0;
      vi.spyOn(qdrant, "createCollection").mockImplementation(async (...args: any[]) => {
        createCallCount++;
        // Let the versioned collection be created, but then the pipeline will fail
        await origCreateCollection(...args);
        // Throw after collection is created to simulate mid-indexing failure
        if (createCallCount === 1) {
          throw new Error("Simulated pipeline failure");
        }
      });

      await expect(ingest.indexCodebase(codebaseDir, { forceReindex: true })).rejects.toThrow(IndexingFailedError);

      vi.restoreAllMocks();
    });

    it("should run orphan cleanup before forceReindex", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const w = 4;");

      // First index
      await ingest.indexCodebase(codebaseDir);

      // Import and spy on cleanup
      const aliasCleanup = await import("../../../../src/core/domains/ingest/alias-cleanup.js");
      const cleanupSpy = vi.spyOn(aliasCleanup, "cleanupOrphanedVersions");

      // Force reindex
      await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(qdrant, expect.stringContaining("code_"));

      vi.restoreAllMocks();
    });
  });

  describe("Error propagation", () => {
    it("should propagate OllamaUnavailableError through indexCodebase when embedding fails", async () => {
      const code = Array.from({ length: 20 }, (_, i) => `export function fn${i}() { return ${i}; }`).join("\n\n");
      await createTestFile(codebaseDir, "test.ts", code);

      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      const failingEmbeddings = new MockEmbeddingProvider();
      vi.spyOn(failingEmbeddings, "embedBatch").mockRejectedValue(ollamaError);

      const failingIngest = new IngestFacade({
        qdrant: qdrant as any,
        embeddings: failingEmbeddings,
        config,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

      await expect(failingIngest.indexCodebase(codebaseDir, { forceReindex: true })).rejects.toThrow(
        OllamaUnavailableError,
      );
    });

    it("should fail health check before indexing when embedding provider is unreachable", async () => {
      // Even with NO files to embed, indexCodebase should fail early
      // if the embedding provider is unreachable (health check)
      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      const failingEmbeddings = new MockEmbeddingProvider();
      vi.spyOn(failingEmbeddings, "embed").mockRejectedValue(ollamaError);

      const failingIngest = new IngestFacade({
        qdrant: qdrant as any,
        embeddings: failingEmbeddings,
        config,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

      await expect(failingIngest.indexCodebase(codebaseDir, { forceReindex: true })).rejects.toThrow(
        OllamaUnavailableError,
      );
    });

    it("should fail health check before reindex when embedding provider is unreachable", async () => {
      // First index succeeds
      const code = Array.from({ length: 20 }, (_, i) => `export function fn${i}() { return ${i}; }`).join("\n\n");
      await createTestFile(codebaseDir, "test.ts", code);
      await ingest.indexCodebase(codebaseDir);

      // Now embed is broken — reindex should fail at health check, even with 0 changes
      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      const failingEmbeddings = new MockEmbeddingProvider();
      vi.spyOn(failingEmbeddings, "embed").mockRejectedValue(ollamaError);

      const failingIngest = new IngestFacade({
        qdrant: qdrant as any,
        embeddings: failingEmbeddings,
        config,
        trajectoryConfig: defaultTrajectoryConfig(),
      });

      await expect(failingIngest.reindexChanges(codebaseDir)).rejects.toThrow(OllamaUnavailableError);
    });
  });

  describe("resumeOptimizer failure is non-fatal", () => {
    it("should complete indexCodebase normally when resumeOptimizer rejects in finally", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export function resumeFailTest(): string {\n  console.log('Testing resume failure');\n  return 'ok';\n}",
      );

      // resumeOptimizer rejects — the finally block's .catch must swallow it
      // and debug-log, without propagating out of indexCodebase.
      const resumeSpy = vi
        .spyOn(qdrant, "resumeOptimizer")
        .mockRejectedValue(new Error("Qdrant 5xx: resumeOptimizer unavailable"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const stats = await ingest.indexCodebase(codebaseDir);

        // Parent method returns normally — no rethrow
        expect(stats.status).toBe("completed");
        expect(stats.filesIndexed).toBe(1);
        // resumeOptimizer was attempted
        expect(resumeSpy).toHaveBeenCalled();
        // DEBUG is on in vitest.setup — failure must be logged via console.error
        const loggedResumeFailure = errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && arg.includes("resumeOptimizer failed")),
        );
        expect(loggedResumeFailure).toBe(true);
      } finally {
        resumeSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
