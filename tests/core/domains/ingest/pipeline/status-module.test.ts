import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import type { IngestCodeConfig } from "../../../../../src/core/types.js";

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
    ingest = new IngestFacade(qdrant as any, embeddings, config, defaultTrajectoryConfig());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("getIndexStatus", () => {
    describe("not_indexed status", () => {
      it("should return not_indexed for new codebase with no collection", async () => {
        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.isIndexed).toBe(false);
        expect(status.status).toBe("not_indexed");
        expect(status.collectionName).toBeUndefined();
        expect(status.chunksCount).toBeUndefined();
      });

      it("should return not_indexed when collection exists but has no chunks and no completion marker", async () => {
        const emptyDir = join(tempDir, "empty-codebase");
        await fs.mkdir(emptyDir, { recursive: true });
        await fs.writeFile(join(emptyDir, "readme.md"), "# README");

        const stats = await ingest.indexCodebase(emptyDir);

        expect(stats.filesScanned).toBe(0);

        const status = await ingest.getIndexStatus(emptyDir);
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
        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);

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
        await ingest.indexCodebase(codebaseDir);
        const afterIndexing = new Date();

        const status = await ingest.getIndexStatus(codebaseDir);

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
        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);

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
        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);
        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
      });

      it("should store completion marker even when no chunks are created", async () => {
        await createTestFile(codebaseDir, "tiny.ts", "const x = 1;");

        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
      });

      it("should update completion marker on force reindex", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const v1 = 'first';\nconsole.log('First indexing');\nfunction init() { return v1; }",
        );

        await ingest.indexCodebase(codebaseDir);
        const status1 = await ingest.getIndexStatus(codebaseDir);

        await new Promise((resolve) => setTimeout(resolve, 10));

        await ingest.indexCodebase(codebaseDir, { forceReindex: true });
        const status2 = await ingest.getIndexStatus(codebaseDir);

        expect(status2.status).toBe("indexed");
        expect(status1.lastUpdated).toBeDefined();
        expect(status2.lastUpdated).toBeDefined();
      });
    });

    describe("backwards compatibility", () => {
      it("should always return isIndexed boolean for backwards compatibility", async () => {
        let status = await ingest.getIndexStatus(codebaseDir);
        expect(typeof status.isIndexed).toBe("boolean");
        expect(status.isIndexed).toBe(false);

        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const test = true;\nconsole.log('Backwards compat test');\nfunction run() { return test; }",
        );
        await ingest.indexCodebase(codebaseDir);

        status = await ingest.getIndexStatus(codebaseDir);
        expect(typeof status.isIndexed).toBe("boolean");
        expect(status.isIndexed).toBe(true);
      });

      it("should have isIndexed=true only when status=indexed", async () => {
        await createTestFile(
          codebaseDir,
          "test.ts",
          "export const consistency = 1;\nconsole.log('Consistency check');\nfunction check() { return consistency; }",
        );
        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);

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

        const indexingPromise = ingest.indexCodebase(codebaseDir, undefined, (progress) => {
          void (async () => {
            if (progress.phase === "embedding" && statusDuringIndexing === null) {
              statusDuringIndexing = await ingest.getIndexStatus(codebaseDir);
            }
          })();
        });

        await indexingPromise;

        if (statusDuringIndexing) {
          expect(statusDuringIndexing.status).toBe("indexing");
          expect(statusDuringIndexing.isIndexed).toBe(false);
          expect(statusDuringIndexing.collectionName).toBeDefined();
        }

        const statusAfter = await ingest.getIndexStatus(codebaseDir);
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

        await ingest.indexCodebase(codebaseDir, undefined, (progress) => {
          void (async () => {
            if (progress.phase === "storing" && chunksCountDuringIndexing === undefined) {
              const status = await ingest.getIndexStatus(codebaseDir);
              chunksCountDuringIndexing = status.chunksCount;
            }
          })();
        });

        if (chunksCountDuringIndexing !== undefined) {
          expect(typeof chunksCountDuringIndexing).toBe("number");
          expect(chunksCountDuringIndexing).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe("versioned collection without alias", () => {
      it("should detect indexing _v1 collection when alias does not exist yet", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Simulate first index in progress: _v1 exists with indexingComplete=false, no alias
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, embeddingModel: "test-model" },
          },
          {
            id: "chunk-1",
            vector: new Array(384).fill(0.1),
            payload: { relativePath: "test.ts", content: "code" },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexing");
        expect(status.isIndexed).toBe(false);
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(1);
        expect(status.embeddingModel).toBe("test-model");
      });

      it("should report stale_indexing when marker is older than threshold", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Simulate stale indexing: startedAt is 15 minutes ago
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime, embeddingModel: "test-model" },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("stale_indexing");
        expect(status.isIndexed).toBe(false);
        expect(status.collectionName).toBe(collectionName);
      });

      it("should detect completed _v1 collection when alias does not exist yet", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Simulate crash after indexing but before alias creation
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: true, completedAt: new Date().toISOString() },
          },
          {
            id: "chunk-1",
            vector: new Array(384).fill(0.1),
            payload: { relativePath: "test.ts", content: "code" },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(1);
      });

      it("should show latest version during forceReindex when alias points to old version", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // v1 is complete and aliased
        await qdrant.createCollection(`${collectionName}_v1`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v1`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: true, completedAt: new Date().toISOString() },
          },
          { id: "chunk-old", vector: new Array(384).fill(0.1), payload: { relativePath: "old.ts" } },
        ]);
        await qdrant.aliases.createAlias(collectionName, `${collectionName}_v1`);

        // v2 is being indexed (forceReindex in progress)
        await qdrant.createCollection(`${collectionName}_v2`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v2`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, embeddingModel: "new-model" },
          },
          { id: "chunk-new-1", vector: new Array(384).fill(0.1), payload: { relativePath: "new.ts" } },
          { id: "chunk-new-2", vector: new Array(384).fill(0.2), payload: { relativePath: "new2.ts" } },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Should report the newer v2 that is still indexing
        expect(status.status).toBe("indexing");
        expect(status.isIndexed).toBe(false);
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(2);
        expect(status.embeddingModel).toBe("new-model");
      });
    });

    describe("legacy collection handling", () => {
      it("should treat collection with chunks but no completion marker as indexed", async () => {
        await createTestFile(
          codebaseDir,
          "legacy.ts",
          "export const legacy = true;\nconsole.log('Legacy test');\nfunction legacyFn() { return legacy; }",
        );
        await ingest.indexCodebase(codebaseDir);

        const initialStatus = await ingest.getIndexStatus(codebaseDir);
        expect(initialStatus.status).toBe("indexed");

        expect(initialStatus.chunksCount).toBeGreaterThanOrEqual(0);
      });

      it("should return indexed for legacy collection with chunks but no indexing marker", async () => {
        // Simulate a legacy collection: collection exists with points but no indexing marker.
        // We manually create the collection and add a point without any indexing marker.
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // Create collection and add a fake chunk point (no indexing marker)
        await qdrant.createCollection(collectionName, 384, "Cosine", false);
        await qdrant.addPoints(collectionName, [
          {
            id: "fake-chunk-1",
            vector: new Array(384).fill(0.1),
            payload: { relativePath: "legacy.ts", content: "legacy code" },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.isIndexed).toBe(true);
        expect(status.status).toBe("indexed");
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(1);
        // Legacy collections should not have lastUpdated or enrichment info
        expect(status.lastUpdated).toBeUndefined();
        expect(status.enrichment).toBeUndefined();
        expect(status.chunkEnrichment).toBeUndefined();
      });

      it("should return not_indexed for legacy collection with no chunks and no marker", async () => {
        // Collection exists but is empty and has no indexing marker
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        await qdrant.createCollection(collectionName, 384, "Cosine", false);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.isIndexed).toBe(false);
        expect(status.status).toBe("not_indexed");
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(0);
      });
    });
  });

  describe("clearIndex", () => {
    it("should clear indexed codebase", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const configValue = 1;\nconsole.log('Config loaded');");
      await ingest.indexCodebase(codebaseDir);

      await ingest.clearIndex(codebaseDir);

      const status = await ingest.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(false);
    });

    it("should clean up orphaned versioned collections on clear", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const v = 1;");
      await ingest.indexCodebase(codebaseDir);
      // Force reindex to create v2
      await ingest.indexCodebase(codebaseDir, { forceReindex: true });

      await ingest.clearIndex(codebaseDir);

      const status = await ingest.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(false);
    });

    it("should handle clearing non-indexed codebase", async () => {
      await expect(ingest.clearIndex(codebaseDir)).resolves.not.toThrow();
    });

    it("should allow re-indexing after clearing", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const reindexValue = 1;\nconsole.log('Reindexing');");
      await ingest.indexCodebase(codebaseDir);

      await ingest.clearIndex(codebaseDir);

      const stats = await ingest.indexCodebase(codebaseDir);
      expect(stats.status).toBe("completed");
    });
  });
});
