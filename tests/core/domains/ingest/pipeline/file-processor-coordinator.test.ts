/**
 * Tests for FileProcessor + ReindexCoordinator integration (Phase 3.2).
 *
 * Verifies that `processFiles` consults the coordinator to gate modified-file
 * upserts when a path's delete silently failed. Blocked files must NOT reach
 * `chunkPipeline.addChunk`; unblocked files must pass through normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../__helpers__/test-helpers.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { FileIngestRecord } from "../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import { createDeletionOutcome } from "../../../../../src/core/domains/ingest/sync/deletion-outcome.js";
import { ReindexCoordinator } from "../../../../../src/core/domains/ingest/sync/reindex-coordinator.js";

// Stub tree-sitter to keep chunker code path inert; chunker is exercised
// elsewhere. The coordinator gate runs BEFORE chunking so this matters only
// for allowed paths that do reach the chunker.
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
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

type ChunkerPoolStub = {
  processFile: ReturnType<typeof vi.fn>;
};

type ChunkPipelineStub = {
  addChunk: ReturnType<typeof vi.fn>;
  isBackpressured: () => boolean;
  waitForBackpressure: () => Promise<boolean>;
};

function makeStubs(chunksPerFile: number): {
  chunkerPool: ChunkerPoolStub;
  chunkPipeline: ChunkPipelineStub;
} {
  const chunkerPool: ChunkerPoolStub = {
    processFile: vi.fn(async (filePath: string) => ({
      chunks: Array.from({ length: chunksPerFile }, (_, idx) => ({
        content: `chunk ${idx} of ${filePath}`,
        startLine: idx * 10 + 1,
        endLine: idx * 10 + 5,
        metadata: {
          filePath,
          language: "typescript",
          chunkIndex: idx,
          name: `sym${idx}`,
          chunkType: "function",
        },
      })),
    })),
  };
  const chunkPipeline: ChunkPipelineStub = {
    addChunk: vi.fn(() => true),
    isBackpressured: () => false,
    waitForBackpressure: async () => true,
  };
  return { chunkerPool, chunkPipeline };
}

describe("processFiles + ReindexCoordinator (Phase 3.2)", () => {
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("skips upsert for files the coordinator reports as blocked", async () => {
    await createTestFile(codebaseDir, "blocked.ts", "export const blocked = 1;\n");
    await createTestFile(codebaseDir, "allowed.ts", "export const allowed = 1;\n");

    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["blocked.ts", "allowed.ts"]);
    outcome.markFailed("blocked.ts");
    coordinator.applyDeletionOutcome(outcome);

    const { chunkerPool, chunkPipeline } = makeStubs(2);

    const result = await processFiles(
      [`${codebaseDir}/blocked.ts`, `${codebaseDir}/allowed.ts`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false, coordinator },
    );

    // Blocked file must never reach the chunker or the pipeline.
    const chunkerCalls = chunkerPool.processFile.mock.calls.map((args) => args[0] as string);
    expect(chunkerCalls).not.toContain(`${codebaseDir}/blocked.ts`);
    expect(chunkerCalls).toContain(`${codebaseDir}/allowed.ts`);

    const addedChunkFilePaths = chunkPipeline.addChunk.mock.calls.map(
      (args) => (args[0] as { metadata: { filePath: string } }).metadata.filePath,
    );
    expect(addedChunkFilePaths.every((p) => p !== `${codebaseDir}/blocked.ts`)).toBe(true);
    expect(addedChunkFilePaths).toContain(`${codebaseDir}/allowed.ts`);

    // Coordinator must have recorded the skip.
    expect(coordinator.skippedFiles()).toContain("blocked.ts");
    // Allowed file still counted as processed.
    expect(result.filesProcessed).toBe(1);
  });

  it("processes all files when no coordinator is provided (added-files path)", async () => {
    await createTestFile(codebaseDir, "a.ts", "export const a = 1;\n");
    await createTestFile(codebaseDir, "b.ts", "export const b = 1;\n");

    const { chunkerPool, chunkPipeline } = makeStubs(1);

    const result = await processFiles(
      [`${codebaseDir}/a.ts`, `${codebaseDir}/b.ts`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false },
    );

    expect(chunkerPool.processFile).toHaveBeenCalledTimes(2);
    expect(chunkPipeline.addChunk).toHaveBeenCalledTimes(2);
    expect(result.filesProcessed).toBe(2);
  });

  it("accepts 'delete-failed' in FileIngestRecord.skipReason union", () => {
    // Compile-time check: if this line type-checks, the union includes
    // "delete-failed". The runtime assertion is trivial.
    const record: FileIngestRecord = {
      path: "x.ts",
      language: "typescript",
      bytes: 0,
      chunks: 0,
      parseMs: 0,
      skipped: true,
      skipReason: "delete-failed",
    };
    expect(record.skipReason).toBe("delete-failed");
  });
});
