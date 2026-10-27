/**
 * bd tea-rags-mcp-muj77 — a file skipped on a NON-quarantinable error (an
 * IngestError such as WorkerTimeoutError) must not enter the sync snapshot as
 * indexed. Otherwise the next incremental pass sees it unchanged and the hole
 * is permanent. The skip is recorded as a retryable `runtimeError` and cleared
 * once the file ingests.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestFacade } from "../../../../src/core/api/index.js";
import { WorkerTimeoutError } from "../../../../src/core/domains/ingest/errors/index.js";
import { ChunkerPool } from "../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { SkippedFileStore } from "../../../../src/core/domains/ingest/sync/skipped-file-store.js";
import { ShardedSnapshotManager } from "../../../../src/core/domains/ingest/sync/snapshot/index.js";
import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "./__helpers__/test-helpers.js";

describe("runtime-skipped file is retried on the next incremental pass", () => {
  let qdrant: MockQdrantManager;
  let ingest: IngestFacade;
  let tempDir: string;
  let codebaseDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    snapshotDir = join(tempDir, "snapshots");
    qdrant = new MockQdrantManager();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      // Blob reads belong to git enrichment, which these fixtures leave off.
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  /** Reject one path's chunker dispatch the way the 120 s liveness bound does. */
  function failChunkingOf(fileName: string): void {
    const original = ChunkerPool.prototype.processFile;
    vi.spyOn(ChunkerPool.prototype, "processFile").mockImplementation(async function (
      this: ChunkerPool,
      ...args: Parameters<ChunkerPool["processFile"]>
    ) {
      if (args[0].endsWith(fileName)) throw new WorkerTimeoutError("chunker", fileName, 120_000);
      return original.apply(this, args);
    });
  }

  async function indexedPaths(collectionName: string): Promise<Set<string>> {
    const points = await qdrant.scrollFiltered(collectionName, {}, 10_000);
    // Service points (indexing marker, schema metadata) carry no relativePath.
    return new Set(points.flatMap((p) => (typeof p.payload.relativePath === "string" ? [p.payload.relativePath] : [])));
  }

  async function snapshotPaths(collectionName: string): Promise<Set<string>> {
    const loaded = await new ShardedSnapshotManager(snapshotDir, collectionName).load();
    return new Set(loaded?.files.keys() ?? []);
  }

  const goodCode = "export function alpha(): number {\n  return 1 + 2 + 3;\n}\n";
  const victimCode = "export function beta(): string {\n  return 'victim body';\n}\n";

  it("first index: the skipped file stays out of the snapshot and is re-ingested next pass", async () => {
    await createTestFile(codebaseDir, "alpha.ts", goodCode);
    await createTestFile(codebaseDir, "beta.ts", victimCode);
    failChunkingOf("beta.ts");

    const first = await ingest.indexCodebase(codebaseDir);
    const { collectionName } = await ingest.getIndexStatus(codebaseDir);
    if (!collectionName) throw new Error("no collection");

    expect(await snapshotPaths(collectionName)).toEqual(new Set(["alpha.ts"]));
    expect(await indexedPaths(collectionName)).toEqual(new Set(["alpha.ts"]));
    expect((await new SkippedFileStore(snapshotDir, collectionName).load()).get("beta.ts")).toMatchObject({
      reason: "runtimeError",
      errorClass: "WorkerTimeoutError",
      retryable: true,
    });
    expect(first.runtimeSkippedFiles).toBe(1);

    vi.restoreAllMocks();
    const second = await ingest.indexCodebase(codebaseDir);

    expect(await indexedPaths(collectionName)).toEqual(new Set(["alpha.ts", "beta.ts"]));
    expect(await snapshotPaths(collectionName)).toEqual(new Set(["alpha.ts", "beta.ts"]));
    expect(await new SkippedFileStore(snapshotDir, collectionName).retryablePaths()).toEqual(new Set());
    expect(second.runtimeSkippedFiles ?? 0).toBe(0);
  });

  it("incremental pass: a modified file that fails keeps its previous snapshot entry and is retried", async () => {
    await createTestFile(codebaseDir, "alpha.ts", goodCode);
    await createTestFile(codebaseDir, "beta.ts", victimCode);
    await ingest.indexCodebase(codebaseDir);
    const { collectionName } = await ingest.getIndexStatus(codebaseDir);
    if (!collectionName) throw new Error("no collection");

    await createTestFile(codebaseDir, "beta.ts", victimCode.replace("victim body", "victim body v2"));
    failChunkingOf("beta.ts");
    const failed = await ingest.indexCodebase(codebaseDir);
    expect(failed.runtimeSkippedFiles).toBe(1);
    expect(await new SkippedFileStore(snapshotDir, collectionName).retryablePaths()).toEqual(new Set(["beta.ts"]));

    vi.restoreAllMocks();
    await ingest.indexCodebase(codebaseDir);

    const points = await qdrant.scrollFiltered(collectionName, {}, 10_000);
    const beta = points.filter((p) => p.payload.relativePath === "beta.ts");
    expect(beta.length).toBeGreaterThan(0);
    expect(beta.some((p) => String(p.payload.content).includes("victim body v2"))).toBe(true);
    expect(await new SkippedFileStore(snapshotDir, collectionName).retryablePaths()).toEqual(new Set());
  });
});
