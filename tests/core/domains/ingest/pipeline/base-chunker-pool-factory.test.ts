/**
 * BaseIndexingPipeline chunker-pool seam (bd tea-rags-mcp-bbo1h.1).
 *
 * A run chunks through the `ChunkerPoolFactory` the facade was given, and builds
 * the default forked `ChunkerPool` only when none was given. The factory receives
 * the run's pool size and chunker config, and the run releases what it was handed
 * exactly once — the same lifecycle the default pool goes through.
 */

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
import type * as ChunkerPoolModule from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type {
  ChunkerPoolFactory,
  ChunkerPoolPort,
} from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";

const { constructedPools } = vi.hoisted(() => ({ constructedPools: [] as unknown[][] }));

vi.mock("../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChunkerPoolModule>();
  class RecordingChunkerPool extends actual.ChunkerPool {
    constructor(...args: ConstructorParameters<typeof actual.ChunkerPool>) {
      constructedPools.push(args);
      super(...args);
    }
  }
  return { ...actual, ChunkerPool: RecordingChunkerPool };
});

function fakeChunkerPort(): ChunkerPoolPort & {
  processFile: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    processFile: vi.fn(async (filePath: string) => ({ filePath, chunks: [] })),
    shutdown: vi.fn(async () => {}),
  };
}

describe("BaseIndexingPipeline chunker-pool factory seam", () => {
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    constructedPools.length = 0;
    ({ tempDir, codebaseDir } = await createTempTestDir());
    await createTestFile(codebaseDir, "app.ts", "export const answer = 42;");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("chunks through the injected factory and never builds the default pool", async () => {
    const port = fakeChunkerPort();
    const createChunkerPool = vi.fn<ChunkerPoolFactory>(() => port);
    const ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as never,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
      createChunkerPool,
    });

    await ingest.indexCodebase(codebaseDir);

    expect(createChunkerPool).toHaveBeenCalledTimes(1);
    const [poolSize, chunkerConfig] = createChunkerPool.mock.calls[0];
    expect(poolSize).toBeGreaterThan(0);
    expect(chunkerConfig).toMatchObject({ chunkSize: 500, chunkOverlap: 50, maxChunkSize: 500 });
    expect(port.processFile).toHaveBeenCalledWith(
      expect.stringContaining("app.ts"),
      "export const answer = 42;",
      "typescript",
      expect.any(Boolean),
    );
    expect(port.shutdown).toHaveBeenCalledTimes(1);
    expect(constructedPools).toHaveLength(0);
  });

  it("builds the default forked pool when no factory is injected", async () => {
    const ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as never,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
    });

    await ingest.indexCodebase(codebaseDir);

    expect(constructedPools).toHaveLength(1);
    expect(constructedPools[0][1]).toMatchObject({ chunkSize: 500, chunkOverlap: 50, maxChunkSize: 500 });
  });
});
