/**
 * bd tea-rags-mcp-muj77 — the snapshot-vs-points consistency probe behind
 * `IndexStatus.indexHoles`: snapshot file count minus the distinct-path count
 * the post-run stats scroll persisted, minus deliberate (deterministic) skips
 * and quarantined files. Holes are lost files; a deliberate skip is not one.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("getIndexStatus — index holes probe", () => {
  let tempDir: string;
  let codebaseDir: string;
  let snapshotDir: string;
  let ingest: IngestFacade;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    snapshotDir = join(tempDir, "snapshots");
    ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as any,
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

  async function indexThreeFilesOneSecretsGated(): Promise<string> {
    await createTestFile(codebaseDir, "a.ts", "export const a = 1;\nconsole.log('a');");
    await createTestFile(codebaseDir, "b.ts", "export const b = 2;\nconsole.log('b');");
    await createTestFile(codebaseDir, "creds.ts", `export const password = "hunter2hunter2";\n`);
    await ingest.indexCodebase(codebaseDir);
    const { collectionName } = await ingest.getIndexStatus(codebaseDir);
    if (!collectionName) throw new Error("no collection");
    return collectionName;
  }

  it("reports no holes when only deterministic skips differ from the points", async () => {
    const collectionName = await indexThreeFilesOneSecretsGated();
    persistPointFileCount(collectionName, 2);

    expect((await ingest.getIndexStatus(codebaseDir)).indexHoles).toBeUndefined();
  });

  it("reports the snapshot files that hold no points", async () => {
    const collectionName = await indexThreeFilesOneSecretsGated();
    persistPointFileCount(collectionName, 1);

    expect((await ingest.getIndexStatus(codebaseDir)).indexHoles).toEqual({ count: 1 });
  });

  it("gives no verdict when the persisted stats predate the snapshot", async () => {
    const collectionName = await indexThreeFilesOneSecretsGated();
    persistPointFileCount(collectionName, 1);
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(join(snapshotDir, `${collectionName}.stats.json`), past, past);

    expect((await ingest.getIndexStatus(codebaseDir)).indexHoles).toBeUndefined();
  });
});
