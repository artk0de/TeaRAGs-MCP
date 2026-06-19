import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import type { ChunkerPool } from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/quarantine-store.js";

describe("processFiles — quarantine integration", () => {
  let baseDir: string;
  let snapshotDir: string;
  let store: QuarantineStore;

  // chunkerPool / chunkPipeline are never reached: fs.readFile throws first.
  const chunkerPool = {} as unknown as ChunkerPool;
  const chunkPipeline = {} as unknown as ChunkPipeline;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `fp-quarantine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    snapshotDir = join(baseDir, "snapshots");
    await fs.mkdir(join(snapshotDir, "test-collection"), { recursive: true });
    store = new QuarantineStore(snapshotDir, "test-collection");
  });

  afterEach(async () => {
    try {
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("quarantines a file that fails to read instead of dropping it silently", async () => {
    const missing = join(baseDir, "missing.ts");

    const result = await processFiles(missing ? [missing] : [], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
      quarantineStore: store,
    });

    const loaded = await store.load();
    const entry = loaded.get("missing.ts");

    expect(result.filesProcessed).toBe(0);
    expect(loaded.size).toBe(1);
    expect(entry?.errorCode).toBe("INGEST_FILE_READ_FAILED");
    expect(entry?.phase).toBe("fs");
    expect(entry?.attempts).toBe(1);
  });

  it("does not throw when no quarantineStore is provided (backward compatible)", async () => {
    const missing = join(baseDir, "missing.ts");

    const result = await processFiles([missing], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
    });

    expect(result.filesProcessed).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});
