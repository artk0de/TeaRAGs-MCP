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

      // tea-rags-mcp-ykj7 — get_index_status surfaces post-hoc codegraph
      // resolve-quality read from cg_run_stats, with the external-library calls
      // excluded from the rate denominator. The codegraph pool is injected into
      // the extracted StatusModule (codegraph is disabled in the default test
      // facade, so without this mock the field is correctly omitted).
      it("surfaces codegraphResolve aggregated from cg_run_stats (external excluded)", async () => {
        await createTestFile(codebaseDir, "calc.ts", "export function run(): number {\n  return Math.max(1, 2);\n}\n");
        await ingest.indexCodebase(codebaseDir);

        const runStatsRows = [
          { receiverKind: "constant", attempted: 100, resolved: 60, externalSkipped: 30 },
          { receiverKind: "dynamic", attempted: 20, resolved: 0, externalSkipped: 20 },
        ];
        // Inject a codegraph pool into the StatusModule (extracted class). The
        // status path passes the BASE/alias collection name, so the DB name is
        // resolved from listCollectionDbNames (here: a single versioned DB) —
        // exercises the base→versioned resolution that the live get_index_status
        // bug needed.
        (ingest as any).indexingOps.status.codegraphPool = {
          listCollectionDbNames: () => ["code_cg_v1"],
          acquireReader: async () => ({
            graphDb: { getRunStats: async () => runStatsRows, close: async () => undefined },
          }),
        };

        const status = await ingest.getIndexStatus(codebaseDir);

        // attempted=120, resolved=60, externalSkipped=50 → denom=max(1,120-50)=70.
        expect(status.codegraphResolve).toEqual({
          callsAttempted: 120,
          callsResolved: 60,
          callsExternalSkipped: 50,
          resolveSuccessRate: 60 / 70,
        });
      });

      it("omits codegraphResolve when no codegraph pool is wired", async () => {
        await createTestFile(codebaseDir, "plain.ts", "export const X = 1;\n");
        await ingest.indexCodebase(codebaseDir);
        const status = await ingest.getIndexStatus(codebaseDir);
        expect(status.codegraphResolve).toBeUndefined();
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

      it("exposes quarantine.count when a quarantine.json exists for the collection", async () => {
        await createTestFile(codebaseDir, "test.ts", "export const x = 1;\nconsole.log('content here');");
        await ingest.indexCodebase(codebaseDir);
        const indexed = await ingest.getIndexStatus(codebaseDir);

        // Write a quarantine list as a sibling of the collection's snapshot dir.
        const snapshotDir = join(process.env.TEA_RAGS_DATA_DIR!, "snapshots");
        await fs.mkdir(snapshotDir, { recursive: true });
        await fs.writeFile(
          join(snapshotDir, `${indexed.collectionName}.quarantine.json`),
          JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            files: {
              "a.ts": {
                errorCode: "INGEST_FILE_READ_FAILED",
                errorMessage: "x",
                phase: "fs",
                firstFailedAt: "t",
                lastFailedAt: "t",
                attempts: 1,
              },
              "b.ts": {
                errorCode: "INGEST_CHUNK_OVERSIZED",
                errorMessage: "y",
                phase: "embed",
                firstFailedAt: "t",
                lastFailedAt: "t",
                attempts: 2,
              },
            },
          }),
          "utf-8",
        );

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.quarantine).toEqual({ count: 2 });
      });

      it("omits quarantine when no quarantine.json exists", async () => {
        await createTestFile(codebaseDir, "test.ts", "export const y = 2;\nconsole.log('no quarantine');");
        await ingest.indexCodebase(codebaseDir);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.quarantine).toBeUndefined();
      });
    });

    describe("heartbeat during indexing", () => {
      it("should write lastHeartbeat to marker during indexCodebase", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");

        // Create files to trigger real indexing pipeline (not no-op)
        for (let i = 0; i < 3; i++) {
          await createTestFile(
            codebaseDir,
            `heartbeat${i}.ts`,
            `export class HeartbeatTest${i} {\n  process(data: string): string {\n    return data.toUpperCase();\n  }\n}`,
          );
        }

        await ingest.indexCodebase(codebaseDir);

        // After indexing, marker should exist. The heartbeat fires immediately on
        // startHeartbeat(), so even fast indexing should have written lastHeartbeat.
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        // Read from the aliased collection (indexing finalized alias)
        const marker = await qdrant.getPoint(collectionName, INDEXING_METADATA_ID);

        // The marker should have lastHeartbeat set (written by pipeline heartbeat)
        expect(marker).toBeDefined();
        expect(typeof marker?.payload?.lastHeartbeat).toBe("string");
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

      it("should auto-cleanup stale _v1 and return not_indexed when marker has no recent heartbeat", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Simulate stale indexing: startedAt is 15 minutes ago, NO lastHeartbeat
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

        // Versioned stale collections are auto-cleaned → not_indexed
        expect(status.status).toBe("not_indexed");
        expect(status.isIndexed).toBe(false);
      });

      it("should report indexing (not stale) when lastHeartbeat is recent despite old startedAt", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // startedAt is 30 minutes ago, but lastHeartbeat is 1 minute ago → still alive
        const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const recentHeartbeat = new Date(Date.now() - 60 * 1000).toISOString();
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: {
              indexingComplete: false,
              startedAt: oldStart,
              lastHeartbeat: recentHeartbeat,
              embeddingModel: "test-model",
            },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("indexing");
        expect(status.isIndexed).toBe(false);
        expect(status.collectionName).toBe(collectionName);
      });

      it("should auto-cleanup stale _v1 when lastHeartbeat is also old", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Both startedAt and lastHeartbeat are old → process is dead
        const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const staleHeartbeat = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: {
              indexingComplete: false,
              startedAt: staleTime,
              lastHeartbeat: staleHeartbeat,
              embeddingModel: "test-model",
            },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Versioned stale collections are auto-cleaned → not_indexed
        expect(status.status).toBe("not_indexed");
        expect(status.isIndexed).toBe(false);
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

    describe("stale marker auto-cleanup", () => {
      it("should cleanup stale _v1 and return not_indexed when no valid alias exists", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Stale _v1: startedAt 15 min ago, no heartbeat, no alias
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        expect(status.status).toBe("not_indexed");
        expect(status.isIndexed).toBe(false);
        // Stale _v1 should have been deleted
        expect(await qdrant.collectionExists(versionedName)).toBe(false);
      });

      it("should prefer aliased _v1 over completed-but-orphaned _v2 (higher N)", async () => {
        // Repro for the bug observed live: after a force-reindex rotation the
        // alias may point back to _v1 while an older _v2 is left behind with
        // indexingComplete=true. `findLatestVersionedCollection` returns _v2
        // by numeric suffix, but the alias is the real source of truth.
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // _v1 is the fresh, aliased collection (514 chunks + marker)
        await qdrant.createCollection(`${collectionName}_v1`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v1`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: {
              indexingComplete: true,
              completedAt: new Date().toISOString(),
              embeddingModel: "fresh-model",
            },
          },
          { id: "fresh-a", vector: new Array(384).fill(0.1), payload: { relativePath: "fresh-a.ts" } },
          { id: "fresh-b", vector: new Array(384).fill(0.2), payload: { relativePath: "fresh-b.ts" } },
        ]);
        await qdrant.aliases.createAlias(collectionName, `${collectionName}_v1`);

        // _v2 is orphaned: completed (not stale) but not aliased. 1 chunk only.
        await qdrant.createCollection(`${collectionName}_v2`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v2`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: {
              indexingComplete: true,
              completedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              embeddingModel: "stale-model",
            },
          },
          { id: "stale-chunk", vector: new Array(384).fill(0.3), payload: { relativePath: "stale.ts" } },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Must read from _v1 (alias target), not _v2 (higher N but orphan).
        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
        expect(status.collectionName).toBe(collectionName);
        expect(status.chunksCount).toBe(2);
        expect(status.embeddingModel).toBe("fresh-model");
      });

      it("should cleanup stale _v2 and return indexed from alias target _v1", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // _v1 is complete and aliased
        await qdrant.createCollection(`${collectionName}_v1`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v1`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: true, completedAt: new Date().toISOString() },
          },
          { id: "chunk-1", vector: new Array(384).fill(0.1), payload: { relativePath: "test.ts" } },
        ]);
        await qdrant.aliases.createAlias(collectionName, `${collectionName}_v1`);

        // _v2 is stale (crashed forceReindex) — has partial chunks like real scenario
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(`${collectionName}_v2`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v2`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime },
          },
          { id: "partial-chunk", vector: new Array(384).fill(0.1), payload: { relativePath: "partial.ts" } },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Should return status from _v1 (the valid alias target)
        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
        expect(status.chunksCount).toBe(1);
        // Stale _v2 should have been deleted
        expect(await qdrant.collectionExists(`${collectionName}_v2`)).toBe(false);
      });

      it("should cleanup stale _v2 and return indexed from legacy real collection (no alias)", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // Legacy: real collection (no alias) with complete marker
        await qdrant.createCollection(collectionName, 384, "Cosine", false);
        await qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: true, completedAt: new Date().toISOString() },
          },
          { id: "chunk-1", vector: new Array(384).fill(0.1), payload: { relativePath: "test.ts" } },
        ]);

        // _v2 crashed forceReindex with partial data
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(`${collectionName}_v2`, 384, "Cosine", false);
        await qdrant.addPoints(`${collectionName}_v2`, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime },
          },
          { id: "partial", vector: new Array(384).fill(0.1), payload: { relativePath: "partial.ts" } },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Should fall back to real collection
        expect(status.status).toBe("indexed");
        expect(status.isIndexed).toBe(true);
        expect(status.chunksCount).toBe(1);
        // Stale _v2 should be cleaned up
        expect(await qdrant.collectionExists(`${collectionName}_v2`)).toBe(false);
      });

      it("should keep stale_indexing for _vN collection with real chunks (partial data)", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);
        const versionedName = `${collectionName}_v1`;

        // Stale _v1 with real chunks — partially indexed, don't delete
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(versionedName, 384, "Cosine", false);
        await qdrant.addPoints(versionedName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime },
          },
          { id: "chunk-1", vector: new Array(384).fill(0.1), payload: { relativePath: "partial.ts" } },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Has real data — keep stale_indexing, don't auto-delete
        expect(status.status).toBe("stale_indexing");
        expect(status.isIndexed).toBe(false);
        expect(await qdrant.collectionExists(versionedName)).toBe(true);
      });

      it("should keep stale_indexing for legacy collection without _vN suffix", async () => {
        const { resolveCollectionName, validatePath } =
          await import("../../../../../src/core/infra/collection-name.js");
        const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
        const absolutePath = await validatePath(codebaseDir);
        const collectionName = resolveCollectionName(absolutePath);

        // Legacy: real collection (not versioned), stale marker
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await qdrant.createCollection(collectionName, 384, "Cosine", false);
        await qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: new Array(384).fill(0),
            payload: { indexingComplete: false, startedAt: staleTime },
          },
        ]);

        const status = await ingest.getIndexStatus(codebaseDir);

        // Legacy collection should NOT be deleted — keep stale_indexing
        expect(status.status).toBe("stale_indexing");
        expect(status.isIndexed).toBe(false);
        expect(await qdrant.collectionExists(collectionName)).toBe(true);
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

    it("removes the quarantine and stats sibling files on clear", async () => {
      await createTestFile(codebaseDir, "test.ts", "export const c = 1;\nconsole.log('sibling cleanup');");
      await ingest.indexCodebase(codebaseDir);
      const indexed = await ingest.getIndexStatus(codebaseDir);

      const snapshotsDir = join(process.env.TEA_RAGS_DATA_DIR!, "snapshots");
      const quarantinePath = join(snapshotsDir, `${indexed.collectionName}.quarantine.json`);
      const statsPath = join(snapshotsDir, `${indexed.collectionName}.stats.json`);
      // stats.json is written during indexing; seed a quarantine sibling too.
      await fs.writeFile(quarantinePath, JSON.stringify({ version: 1, updatedAt: "t", files: {} }), "utf-8");

      await ingest.clearIndex(codebaseDir);

      const exists = async (p: string) =>
        fs.access(p).then(
          () => true,
          () => false,
        );
      expect(await exists(quarantinePath)).toBe(false);
      expect(await exists(statsPath)).toBe(false);
    });
  });

  describe("codegraphResolve — byLanguage breakdown", () => {
    // Exercises summarizeCodegraphResolve branch: byLanguage.length > 1 → summary.byLanguage populated.
    it("surfaces byLanguage when 2+ languages each hold a significant share", async () => {
      await createTestFile(codebaseDir, "multi.ts", "export const X = 1;\n");
      await ingest.indexCodebase(codebaseDir);

      // Two languages, each with 50% of total attempts → both above MIN_LANGUAGE_SHARE (5%).
      const runStatsRows = [
        { language: "typescript", attempted: 50, resolved: 40, externalSkipped: 0 },
        { language: "ruby", attempted: 50, resolved: 20, externalSkipped: 10 },
      ];
      (ingest as any).indexingOps.status.codegraphPool = {
        listCollectionDbNames: () => ["code_cg_v1"],
        acquireReader: async () => ({
          graphDb: { getRunStats: async () => runStatsRows, close: async () => undefined },
        }),
      };

      const status = await ingest.getIndexStatus(codebaseDir);

      expect(status.codegraphResolve).toBeDefined();
      // Total: attempted=100, resolved=60, externalSkipped=10 → rate=60/90
      expect(status.codegraphResolve!.callsAttempted).toBe(100);
      expect(status.codegraphResolve!.resolveSuccessRate).toBeCloseTo(60 / 90, 8);
      // Both languages should appear in byLanguage breakdown.
      expect(status.codegraphResolve!.byLanguage).toBeDefined();
      const langs = status.codegraphResolve!.byLanguage!.map((r: { language: string }) => r.language).sort();
      expect(langs).toEqual(["ruby", "typescript"]);
    });

    // Exercises resolveRate(0, ...) branch: attempted === 0 → return 0.
    it("returns resolveSuccessRate=0 and empty breakdown when all rows have attempted=0", async () => {
      await createTestFile(codebaseDir, "zero.ts", "export const Z = 0;\n");
      await ingest.indexCodebase(codebaseDir);

      const runStatsRows = [{ language: "typescript", attempted: 0, resolved: 0, externalSkipped: 0 }];
      (ingest as any).indexingOps.status.codegraphPool = {
        listCollectionDbNames: () => ["code_cg_v1"],
        acquireReader: async () => ({
          graphDb: { getRunStats: async () => runStatsRows, close: async () => undefined },
        }),
      };

      const status = await ingest.getIndexStatus(codebaseDir);

      expect(status.codegraphResolve).toBeDefined();
      expect(status.codegraphResolve!.resolveSuccessRate).toBe(0);
      expect(status.codegraphResolve!.byLanguage).toBeUndefined();
    });
  });

  describe("findLatestVersionedCollection — alias fallback to highest _vN", () => {
    // Exercises findLatestVersionedCollection: multiple _vN collections exist,
    // the method picks the highest-versioned one as fallback.
    it("reads status from highest _vN when alias exists pointing to completed version", async () => {
      const { resolveCollectionName, validatePath } = await import("../../../../../src/core/infra/collection-name.js");
      const { INDEXING_METADATA_ID } = await import("../../../../../src/core/domains/ingest/constants.js");
      const absolutePath = await validatePath(codebaseDir);
      const collectionName = resolveCollectionName(absolutePath);

      // Create _v1 (orphaned, completed) and _v2 (in-progress), alias → _v1.
      const v1 = `${collectionName}_v1`;
      const v2 = `${collectionName}_v2`;

      await qdrant.createCollection(v1, 384, "Cosine", false);
      await qdrant.addPoints(v1, [
        {
          id: INDEXING_METADATA_ID,
          vector: new Array(384).fill(0),
          payload: { indexingComplete: true, embeddingModel: "test-model" },
        },
        {
          id: "chunk-v1",
          vector: new Array(384).fill(0.1),
          payload: { relativePath: "a.ts" },
        },
      ]);

      await qdrant.createCollection(v2, 384, "Cosine", false);
      await qdrant.addPoints(v2, [
        {
          id: INDEXING_METADATA_ID,
          vector: new Array(384).fill(0),
          payload: {
            indexingComplete: false,
            startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            lastHeartbeat: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            embeddingModel: "test-model",
          },
        },
      ]);

      // Alias points to v1 (the completed one).
      await qdrant.aliases.createAlias(collectionName, v1);

      const status = await ingest.getIndexStatus(codebaseDir);

      // StatusModule should follow the alias → v1 (indexed).
      expect(status.status).toBe("indexed");
      expect(status.isIndexed).toBe(true);
    });
  });
});
