/**
 * GitHub #10 — a chunk the pipeline refuses under backpressure must be
 * resubmitted, never dropped. `ChunkPipeline#addChunk` returns false while its
 * accumulator is paused and keeps no copy; `waitForBackpressure` returns false
 * on timeout with the pause still on. A slow (CPU) embedder holds the pause
 * past that timeout, and a refused chunk that is not retried is missing from
 * the index while the snapshot still lists its file.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import type { ChunkerPool } from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";

const CHUNKS_PER_FILE = 3;

/** Chunker double: every file yields CHUNKS_PER_FILE distinct chunks. */
const chunkerPool = {
  processFile: async (filePath: string, code: string) => ({
    chunks: Array.from({ length: CHUNKS_PER_FILE }, (_, i) => ({
      content: `${code}#${i}`,
      startLine: i + 1,
      endLine: i + 1,
      metadata: { filePath, language: "markdown", chunkIndex: i },
    })),
  }),
} as unknown as ChunkerPool;

/**
 * Pipeline double with the real contract: refuses every chunk while paused;
 * the first wait times out with the pause still on, the second sees it lift.
 */
function stalledPipeline() {
  let paused = true;
  let waits = 0;
  const accepted: string[] = [];
  const pipeline = {
    isBackpressured: () => paused,
    waitForBackpressure: vi.fn(async () => {
      waits++;
      if (waits === 1) return false;
      paused = false;
      return true;
    }),
    addChunk: vi.fn((_chunk: unknown, chunkId: string) => {
      if (paused) return false;
      accepted.push(chunkId);
      return true;
    }),
  };
  return { pipeline: pipeline as unknown as ChunkPipeline, accepted };
}

describe("processFiles — backpressure refusal (GitHub #10)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `fp-backpressure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("resubmits a chunk refused after a backpressure wait timed out, so every chunk is accepted", async () => {
    const file = join(baseDir, "guide.md");
    await fs.writeFile(file, "# Guide\n", "utf-8");
    const { pipeline, accepted } = stalledPipeline();

    const result = await processFiles([file], baseDir, chunkerPool, pipeline, {
      enableGitMetadata: false,
      concurrency: 1,
    });

    expect(accepted).toHaveLength(CHUNKS_PER_FILE);
    expect(new Set(accepted).size).toBe(CHUNKS_PER_FILE);
    expect(result.chunksCreated).toBe(accepted.length);
  });
});
