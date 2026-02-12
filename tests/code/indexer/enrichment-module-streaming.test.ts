/**
 * Tests for streaming EnrichmentModule API
 *
 * Validates: prefetchGitLog, onChunksStored (streaming + pending queue),
 * startChunkChurn, awaitCompletion, graceful error handling.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkItem } from "../../../src/code/pipeline/types.js";
import type { ChunkLookupEntry } from "../../../src/code/types.js";

// Shared mock state — vi.hoisted runs before vi.mock factory
const { mockBuildFileMetadataMap, mockBuildChunkChurnMap, mockComputeFileMetadata } = vi.hoisted(() => ({
  mockBuildFileMetadataMap: vi.fn(),
  mockBuildChunkChurnMap: vi.fn(),
  mockComputeFileMetadata: vi.fn().mockReturnValue({
    dominantAuthor: "Alice",
    dominantAuthorEmail: "alice@test.com",
    authors: ["Alice"],
    dominantAuthorPct: 100,
    lastModifiedAt: 1700000000,
    firstCreatedAt: 1690000000,
    lastCommitHash: "abc123",
    ageDays: 10,
    commitCount: 5,
    linesAdded: 100,
    linesDeleted: 20,
    relativeChurn: 0.5,
    recencyWeightedFreq: 2.5,
    changeDensity: 1.5,
    churnVolatility: 0.8,
    bugFixRate: 20,
    contributorCount: 1,
    taskIds: ["TD-100"],
  }),
}));

vi.mock("../../../src/code/git/git-log-reader.js", () => ({
  GitLogReader: class MockGitLogReader {
    buildFileMetadataMap = mockBuildFileMetadataMap;
    buildChunkChurnMap = mockBuildChunkChurnMap;
  },
  computeFileMetadata: mockComputeFileMetadata,
}));

// Import AFTER mock setup
import { EnrichmentModule } from "../../../src/code/indexer/enrichment-module.js";

// Helpers
function createMockQdrant() {
  return {
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    setPayload: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChunkItems(
  filePaths: string[],
  codebasePath: string,
): ChunkItem[] {
  return filePaths.map((fp, i) => ({
    type: "upsert" as const,
    id: `chunk-${i}`,
    chunk: {
      content: `content ${i}`,
      startLine: 1,
      endLine: 10,
      metadata: {
        filePath: fp,
        language: "typescript",
        chunkIndex: 0,
      },
    },
    chunkId: `chunk-${i}`,
    codebasePath,
  }));
}

describe("EnrichmentModule streaming API", () => {
  let qdrant: ReturnType<typeof createMockQdrant>;
  let enrichment: EnrichmentModule;
  let repoDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    qdrant = createMockQdrant();
    enrichment = new EnrichmentModule(qdrant as any);

    // Create a temp dir with a fake .git so prefetchGitLog doesn't skip
    repoDir = join(tmpdir(), `enrichment-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(repoDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  describe("prefetchGitLog", () => {
    it("should start async git log reading", async () => {
      const fileMap = new Map([
        ["a.ts", { commits: [], linesAdded: 10, linesDeleted: 2 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir);

      const metrics = await enrichment.awaitCompletion("test_collection");
      expect(mockBuildFileMetadataMap).toHaveBeenCalledWith(repoDir);
      expect(metrics.prefetchDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("onChunksStored - streaming apply", () => {
    it("should apply metadata immediately when git log already resolved", async () => {
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir);

      // Wait for git log to resolve
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(qdrant.batchSetPayload).toHaveBeenCalled();
      expect(metrics.streamingApplies).toBeGreaterThanOrEqual(1);
    });
  });

  describe("onChunksStored - pending queue", () => {
    it("should queue batch when git log not ready yet", async () => {
      // Make git log resolve after a delay
      let resolveGitLog!: (value: Map<string, any>) => void;
      const gitLogPromise = new Promise<Map<string, any>>((resolve) => {
        resolveGitLog = resolve;
      });
      mockBuildFileMetadataMap.mockReturnValue(gitLogPromise);

      enrichment.prefetchGitLog(repoDir);

      // onChunksStored BEFORE git log resolves — should queue
      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      // batchSetPayload should NOT have been called yet
      expect(qdrant.batchSetPayload).not.toHaveBeenCalled();

      // Now resolve git log
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
      ]);
      resolveGitLog(fileMap);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // Now batchSetPayload should have been called (flushed from queue)
      expect(qdrant.batchSetPayload).toHaveBeenCalled();
      expect(metrics.flushApplies).toBeGreaterThanOrEqual(1);
    });
  });

  describe("startChunkChurn", () => {
    it("should trigger chunk-level overlays", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      const chunkChurnResult = new Map([
        [
          "a.ts",
          new Map([
            [
              "chunk-0",
              {
                chunkCommitCount: 3,
                chunkChurnRatio: 0.6,
                chunkContributorCount: 2,
                chunkBugFixRate: 33,
                chunkLastModifiedAt: 1700000000,
                chunkAgeDays: 5,
              },
            ],
          ]),
        ],
      ]);
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      enrichment.prefetchGitLog(repoDir);

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(mockBuildChunkChurnMap).toHaveBeenCalled();
      expect(metrics.chunkChurnDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("awaitCompletion", () => {
    it("should wait for all work and return metrics", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());
      mockBuildChunkChurnMap.mockResolvedValue(new Map());

      enrichment.prefetchGitLog(repoDir);

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics).toHaveProperty("prefetchDurationMs");
      expect(metrics).toHaveProperty("overlapMs");
      expect(metrics).toHaveProperty("overlapRatio");
      expect(metrics).toHaveProperty("streamingApplies");
      expect(metrics).toHaveProperty("flushApplies");
      expect(metrics).toHaveProperty("chunkChurnDurationMs");
      expect(metrics).toHaveProperty("totalDurationMs");
    });

    it("should update enrichment marker to completed", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      enrichment.prefetchGitLog(repoDir);
      await enrichment.awaitCompletion("test_collection");

      const calls = qdrant.setPayload.mock.calls;
      const completionCall = calls.find(
        (c: any[]) => c[1]?.enrichment?.status === "completed",
      );
      expect(completionCall).toBeDefined();
    });
  });

  describe("path mismatch diagnostics", () => {
    it("should track matched and missed files in metrics", async () => {
      // Git log has "a.ts" but NOT "b.ts"
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Send chunks for both a.ts (matched) and b.ts (missed)
      const items = makeChunkItems(
        [`${repoDir}/a.ts`, `${repoDir}/b.ts`],
        repoDir,
      );
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics.matchedFiles).toBe(1);
      expect(metrics.missedFiles).toBe(1);
      expect(metrics.missedPathSamples).toEqual(["b.ts"]);
    });

    it("should cap missedPathSamples at 10 entries", async () => {
      // Git log has no files
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Send chunks for 15 different files, all will miss
      const paths = Array.from({ length: 15 }, (_, i) => `${repoDir}/file${i}.ts`);
      const items = makeChunkItems(paths, repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics.missedFiles).toBe(15);
      expect(metrics.missedPathSamples).toHaveLength(10);
    });
  });

  describe("streaming savings estimate", () => {
    it("should report estimatedSavedMs based on overlap", async () => {
      // Make git log take some time to resolve
      let resolveGitLog!: (value: Map<string, any>) => void;
      const gitLogPromise = new Promise<Map<string, any>>((resolve) => {
        resolveGitLog = resolve;
      });
      mockBuildFileMetadataMap.mockReturnValue(gitLogPromise);

      enrichment.prefetchGitLog(repoDir);

      // Send chunks while git log is still reading (creates overlap)
      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      // Resolve git log after a short delay
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
      ]);
      resolveGitLog(fileMap);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // estimatedSavedMs should equal overlapMs (clamped to >= 0)
      expect(metrics.estimatedSavedMs).toBe(metrics.overlapMs);
      expect(metrics.estimatedSavedMs).toBeGreaterThanOrEqual(0);
    });

    it("should include estimatedSavedMs in metrics when no overlap", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      enrichment.prefetchGitLog(repoDir);
      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics).toHaveProperty("estimatedSavedMs");
      expect(metrics.estimatedSavedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("fire-and-forget enrichment", () => {
    it("should not block awaitCompletion on slow chunk churn", async () => {
      // Git log resolves immediately
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Chunk churn takes forever (simulates taxdome hang)
      let resolveChunkChurn!: (value: Map<string, any>) => void;
      const slowChunkChurn = new Promise<Map<string, any>>((resolve) => {
        resolveChunkChurn = resolve;
      });
      mockBuildChunkChurnMap.mockReturnValue(slowChunkChurn);

      enrichment.prefetchGitLog(repoDir);

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [
          { chunkId: "chunk-0", startLine: 1, endLine: 10 },
          { chunkId: "chunk-1", startLine: 11, endLine: 20 },
        ]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      // awaitCompletion should resolve WITHOUT waiting for chunk churn
      const metrics = await enrichment.awaitCompletion("test_collection");
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);

      // Chunk churn is still running at this point — that's fine
      // Clean up: resolve to avoid unhandled promise
      resolveChunkChurn(new Map());
    });
  });

  describe("enrichment start marker", () => {
    it("should set enrichment marker to in_progress on prefetchGitLog", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      enrichment.prefetchGitLog(repoDir, "test_collection");

      // Should have called setPayload with enrichment.status = "in_progress"
      const calls = qdrant.setPayload.mock.calls;
      const inProgressCall = calls.find(
        (c: any[]) => c[1]?.enrichment?.status === "in_progress",
      );
      expect(inProgressCall).toBeDefined();
    });
  });

  describe("enrichment marker with diagnostics", () => {
    it("should write matchedFiles and missedFiles to enrichment marker on completion", async () => {
      // Git log has "a.ts" but NOT "b.ts"
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir, "test_collection");
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems(
        [`${repoDir}/a.ts`, `${repoDir}/b.ts`],
        repoDir,
      );
      enrichment.onChunksStored("test_collection", repoDir, items);

      await enrichment.awaitCompletion("test_collection");

      // Find the completion marker call
      const calls = qdrant.setPayload.mock.calls;
      const completionCall = calls.find(
        (c: any[]) => c[1]?.enrichment?.status === "completed",
      );
      expect(completionCall).toBeDefined();

      const enrichmentPayload = completionCall![1].enrichment;
      expect(enrichmentPayload.matchedFiles).toBe(1);
      expect(enrichmentPayload.missedFiles).toBe(1);
    });
  });

  describe("chunk churn marker", () => {
    it("should write chunkEnrichment status to Qdrant when chunk churn completes", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      const chunkChurnResult = new Map([
        [
          "a.ts",
          new Map([
            ["chunk-0", {
              chunkCommitCount: 3,
              chunkChurnRatio: 0.6,
              chunkContributorCount: 2,
              chunkBugFixRate: 33,
              chunkLastModifiedAt: 1700000000,
              chunkAgeDays: 5,
            }],
          ]),
        ],
      ]);
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      enrichment.prefetchGitLog(repoDir, "test_collection");

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [
          { chunkId: "chunk-0", startLine: 1, endLine: 10 },
          { chunkId: "chunk-1", startLine: 11, endLine: 20 },
        ]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      // Wait for chunk churn to complete (it's fire-and-forget but we can wait a bit)
      await new Promise((r) => setTimeout(r, 50));

      // Find the chunkEnrichment marker call
      const calls = qdrant.setPayload.mock.calls;
      const chunkChurnCall = calls.find(
        (c: any[]) => c[1]?.chunkEnrichment?.status === "completed",
      );
      expect(chunkChurnCall).toBeDefined();
      expect(chunkChurnCall![1].chunkEnrichment.overlaysApplied).toBeGreaterThanOrEqual(0);
    });
  });

  describe("error handling", () => {
    it("should not crash when git log prefetch fails", async () => {
      mockBuildFileMetadataMap.mockRejectedValue(new Error("git log failed"));

      enrichment.prefetchGitLog(repoDir);

      // onChunksStored should still work (graceful degradation)
      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // Should complete without throwing
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("should not block other batches when batchSetPayload fails", async () => {
      const fileMap = new Map([
        ["a.ts", { commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 10, linesDeleted: 2 }],
        ["b.ts", { commits: [{ sha: "def", author: "Bob", authorEmail: "b@t.com", timestamp: 1700000000, body: "init" }], linesAdded: 5, linesDeleted: 1 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      // First call fails, second succeeds
      qdrant.batchSetPayload
        .mockRejectedValueOnce(new Error("Qdrant error"))
        .mockResolvedValue(undefined);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Two separate batches
      const items1 = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items1);

      const items2 = makeChunkItems([`${repoDir}/b.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items2);

      // Should not throw even though first batch failed
      const metrics = await enrichment.awaitCompletion("test_collection");
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
