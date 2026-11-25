/**
 * GitHub #10 — an incremental run repairs index holes: files the snapshot lists
 * as indexed that hold no points. Before the repair they stayed lost forever,
 * because their content is unchanged and change detection skipped them.
 */
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
import { StatsCache } from "../../../../../src/core/adapters/filesystem/stats-cache.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";

describe("reindexChanges — index hole repair (GitHub #10)", () => {
  let tempDir: string;
  let codebaseDir: string;
  let snapshotDir: string;
  let qdrant: MockQdrantManager;
  let ingest: IngestFacade;

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
    await cleanupTempDir(tempDir);
  });

  /** What the post-run stats scroll persists: the distinct relativePath count of the points. */
  function persistPointFileCount(collectionName: string, totalFiles: number): void {
    new StatsCache(snapshotDir).save(collectionName, {
      perSignal: new Map(),
      perLanguage: new Map(),
      distributions: { totalFiles } as never,
      computedAt: Date.now(),
    });
  }

  /** Index two files, then lose every point of `b.ts` the way a dropped chunk did. */
  async function indexWithLostFile(): Promise<string> {
    await createTestFile(codebaseDir, "a.ts", "export const a = 1;\nconsole.log('a');");
    await createTestFile(codebaseDir, "b.ts", "export const b = 2;\nconsole.log('b');");
    await ingest.indexCodebase(codebaseDir);
    const { collectionName } = await ingest.getIndexStatus(codebaseDir);
    if (!collectionName) throw new Error("no collection");
    await qdrant.deletePointsByPaths(collectionName, ["b.ts"]);
    return collectionName;
  }

  it("re-ingests a snapshot file that holds no points", async () => {
    const collectionName = await indexWithLostFile();
    persistPointFileCount(collectionName, 1);

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesHolesRepaired).toBe(1);
    expect(await qdrant.scrollFieldValues(collectionName, "relativePath")).toContain("b.ts");
  });

  it("scans no points when the count-level probe sees no hole", async () => {
    const collectionName = await indexWithLostFile();
    persistPointFileCount(collectionName, 2);
    const scan = vi.spyOn(qdrant, "scrollFieldValues");

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesHolesRepaired).toBeUndefined();
    expect(scan).not.toHaveBeenCalledWith(expect.anything(), "relativePath");
  });

  it("repairs nothing when the persisted stats predate the snapshot", async () => {
    const collectionName = await indexWithLostFile();
    persistPointFileCount(collectionName, 1);
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(join(snapshotDir, `${collectionName}.stats.json`), past, past);

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesHolesRepaired).toBeUndefined();
    expect(await qdrant.scrollFieldValues(collectionName, "relativePath")).not.toContain("b.ts");
  });
});
