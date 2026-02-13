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

// Import AFTER mock setup
import { EnrichmentModule } from "../../../src/code/indexer/enrichment-module.js";
import type { ChunkItem } from "../../../src/code/pipeline/types.js";
import type { ChunkLookupEntry } from "../../../src/code/types.js";

// Shared mock state — vi.hoisted runs before vi.mock factory
const { mockBuildFileMetadataMap, mockBuildChunkChurnMap, mockComputeFileMetadata, mockBuildFileMetadataForPaths } =
  vi.hoisted(() => ({
    mockBuildFileMetadataMap: vi.fn(),
    mockBuildChunkChurnMap: vi.fn(),
    mockBuildFileMetadataForPaths: vi.fn(),
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
    buildFileMetadataForPaths = mockBuildFileMetadataForPaths;
  },
  computeFileMetadata: mockComputeFileMetadata,
}));

// Helpers
function createMockQdrant() {
  return {
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    setPayload: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChunkItems(filePaths: string[], codebasePath: string): ChunkItem[] {
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

    // Default: backfill returns empty map (safe for tests that don't care about backfill)
    mockBuildFileMetadataForPaths.mockResolvedValue(new Map());

    // Create a temp dir with a fake .git so prefetchGitLog doesn't skip
    repoDir = join(tmpdir(), `enrichment-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(repoDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  describe("prefetchGitLog", () => {
    it("should start async git log reading", async () => {
      const fileMap = new Map([["a.ts", { commits: [], linesAdded: 10, linesDeleted: 2 }]]);
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
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
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
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
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
      const completionCall = calls.find((c: any[]) => c[1]?.enrichment?.status === "completed");
      expect(completionCall).toBeDefined();
    });
  });

  describe("path mismatch diagnostics", () => {
    it("should track matched and missed files in metrics", async () => {
      // Git log has "a.ts" but NOT "b.ts"
      const fileMap = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Send chunks for both a.ts (matched) and b.ts (missed)
      const items = makeChunkItems([`${repoDir}/a.ts`, `${repoDir}/b.ts`], repoDir);
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
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
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
        [
          `${repoDir}/a.ts`,
          [
            { chunkId: "chunk-0", startLine: 1, endLine: 10 },
            { chunkId: "chunk-1", startLine: 11, endLine: 20 },
          ],
        ],
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
      const inProgressCall = calls.find((c: any[]) => c[1]?.enrichment?.status === "in_progress");
      expect(inProgressCall).toBeDefined();
    });
  });

  describe("enrichment marker with diagnostics", () => {
    it("should write matchedFiles and missedFiles to enrichment marker on completion", async () => {
      // Git log has "a.ts" but NOT "b.ts"
      const fileMap = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir, "test_collection");
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`, `${repoDir}/b.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      await enrichment.awaitCompletion("test_collection");

      // Find the completion marker call
      const calls = qdrant.setPayload.mock.calls;
      const completionCall = calls.find((c: any[]) => c[1]?.enrichment?.status === "completed");
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

      enrichment.prefetchGitLog(repoDir, "test_collection");

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [
          `${repoDir}/a.ts`,
          [
            { chunkId: "chunk-0", startLine: 1, endLine: 10 },
            { chunkId: "chunk-1", startLine: 11, endLine: 20 },
          ],
        ],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      // Wait for chunk churn to complete (it's fire-and-forget but we can wait a bit)
      await new Promise((r) => setTimeout(r, 50));

      // Find the chunkEnrichment marker call
      const calls = qdrant.setPayload.mock.calls;
      const chunkChurnCall = calls.find((c: any[]) => c[1]?.chunkEnrichment?.status === "completed");
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
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
        [
          "b.ts",
          {
            commits: [{ sha: "def", author: "Bob", authorEmail: "b@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 5,
            linesDeleted: 1,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      // First call fails, second succeeds
      qdrant.batchSetPayload.mockRejectedValueOnce(new Error("Qdrant error")).mockResolvedValue(undefined);

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

  describe("prefetchGitLog ignoreFilter", () => {
    it("should filter git log results by ignore patterns", async () => {
      // Git log returns files including ignored ones
      const fileMap = new Map([
        ["a.ts", { commits: [], linesAdded: 10, linesDeleted: 2 }],
        ["node_modules/dep.js", { commits: [], linesAdded: 5, linesDeleted: 0 }],
        ["b.ts", { commits: [], linesAdded: 3, linesDeleted: 1 }],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      const mockIgnoreFilter = {
        ignores: vi.fn((path: string) => path.startsWith("node_modules/")),
      };

      enrichment.prefetchGitLog(repoDir, "test_collection", mockIgnoreFilter as any);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // "node_modules/dep.js" should have been filtered out
      expect(mockIgnoreFilter.ignores).toHaveBeenCalled();
      expect(metrics.gitLogFileCount).toBe(2); // a.ts + b.ts remain
    });

    it("should not filter when no ignored files match", async () => {
      const fileMap = new Map([["a.ts", { commits: [], linesAdded: 10, linesDeleted: 2 }]]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      const mockIgnoreFilter = {
        ignores: vi.fn().mockReturnValue(false),
      };

      enrichment.prefetchGitLog(repoDir, "test_collection", mockIgnoreFilter as any);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics.gitLogFileCount).toBe(1);
    });
  });

  describe("GIT_CHUNK_ENABLED=false early return", () => {
    it("should skip chunk churn when GIT_CHUNK_ENABLED is false", async () => {
      const originalEnv = process.env.GIT_CHUNK_ENABLED;
      process.env.GIT_CHUNK_ENABLED = "false";

      try {
        mockBuildFileMetadataMap.mockResolvedValue(new Map());
        mockBuildChunkChurnMap.mockResolvedValue(new Map());

        enrichment.prefetchGitLog(repoDir);
        await new Promise((r) => setTimeout(r, 10));

        const chunkMap = new Map<string, ChunkLookupEntry[]>([
          [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
        ]);
        enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

        // buildChunkChurnMap should NOT have been called
        expect(mockBuildChunkChurnMap).not.toHaveBeenCalled();
      } finally {
        if (originalEnv !== undefined) {
          process.env.GIT_CHUNK_ENABLED = originalEnv;
        } else {
          delete process.env.GIT_CHUNK_ENABLED;
        }
      }
    });
  });

  describe("startChunkChurn ignoreFilter", () => {
    it("should filter chunkMap by ignore patterns before processing", async () => {
      const fileMap = new Map([["a.ts", { commits: [], linesAdded: 10, linesDeleted: 2 }]]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      const chunkChurnResult = new Map();
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      const mockIgnoreFilter = {
        ignores: vi.fn((path: string) => path === "ignored.ts"),
      };

      enrichment.prefetchGitLog(repoDir, "test_collection", mockIgnoreFilter as any);
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
        [`${repoDir}/ignored.ts`, [{ chunkId: "chunk-1", startLine: 1, endLine: 5 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      // Wait for async chunk churn to complete
      await new Promise((r) => setTimeout(r, 50));

      // buildChunkChurnMap should have been called with filtered map (only a.ts)
      expect(mockBuildChunkChurnMap).toHaveBeenCalled();
      const passedChunkMap = mockBuildChunkChurnMap.mock.calls[0][1] as Map<string, any>;
      expect(passedChunkMap.has(`${repoDir}/a.ts`)).toBe(true);
      expect(passedChunkMap.has(`${repoDir}/ignored.ts`)).toBe(false);
    });

    it("should not filter chunkMap when no files are ignored", async () => {
      const fileMap = new Map();
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);
      mockBuildChunkChurnMap.mockResolvedValue(new Map());

      const mockIgnoreFilter = {
        ignores: vi.fn().mockReturnValue(false),
      };

      enrichment.prefetchGitLog(repoDir, "test_collection", mockIgnoreFilter as any);
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockBuildChunkChurnMap).toHaveBeenCalled();
      const passedChunkMap = mockBuildChunkChurnMap.mock.calls[0][1] as Map<string, any>;
      expect(passedChunkMap.size).toBe(1);
    });
  });

  describe("chunk overlay batch error handlers", () => {
    it("should handle batchSetPayload error in chunk churn mid-batch", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Create enough chunk overlays to trigger a mid-batch flush (BATCH_SIZE = 100)
      const chunkOverlays = new Map<string, any>();
      for (let i = 0; i < 105; i++) {
        chunkOverlays.set(`chunk-${i}`, {
          chunkCommitCount: 3,
          chunkChurnRatio: 0.6,
          chunkContributorCount: 2,
          chunkBugFixRate: 33,
          chunkLastModifiedAt: 1700000000,
          chunkAgeDays: 5,
        });
      }
      const chunkChurnResult = new Map([["a.ts", chunkOverlays]]);
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      // Make batchSetPayload fail on first call (mid-batch) but succeed on remainder
      qdrant.batchSetPayload.mockRejectedValueOnce(new Error("Qdrant batch error")).mockResolvedValue(undefined);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir, "test_collection");
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      await new Promise((r) => setTimeout(r, 100));

      // Error should have been logged (DEBUG is "true" in test env)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Chunk churn batch failed:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it("should handle batchSetPayload error in chunk churn final batch", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Create a small number of overlays (< BATCH_SIZE) to trigger only the final batch
      const chunkChurnResult = new Map([
        [
          "a.ts",
          new Map([
            [
              "chunk-0",
              {
                chunkCommitCount: 1,
                chunkChurnRatio: 0.5,
                chunkContributorCount: 1,
                chunkBugFixRate: 0,
                chunkLastModifiedAt: 1700000000,
                chunkAgeDays: 3,
              },
            ],
          ]),
        ],
      ]);
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      // Make batchSetPayload fail (this will be the final batch flush)
      qdrant.batchSetPayload.mockRejectedValueOnce(new Error("Final batch error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir, "test_collection");
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      await new Promise((r) => setTimeout(r, 100));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Chunk churn final batch failed:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("chunk enrichment marker error", () => {
    it("should handle setPayload error when writing chunk enrichment marker", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      const chunkChurnResult = new Map([
        [
          "a.ts",
          new Map([
            [
              "chunk-0",
              {
                chunkCommitCount: 2,
                chunkChurnRatio: 0.4,
                chunkContributorCount: 1,
                chunkBugFixRate: 50,
                chunkLastModifiedAt: 1700000000,
                chunkAgeDays: 7,
              },
            ],
          ]),
        ],
      ]);
      mockBuildChunkChurnMap.mockResolvedValue(chunkChurnResult);

      // batchSetPayload succeeds (for chunk overlay) but setPayload fails (for marker)
      qdrant.batchSetPayload.mockResolvedValue(undefined);
      qdrant.setPayload.mockRejectedValue(new Error("Marker write failed"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      await new Promise((r) => setTimeout(r, 100));

      // Should have logged the chunk enrichment marker error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Failed to update chunk enrichment marker:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("updateEnrichmentMarker", () => {
    it("should compute percentage when totalFiles and processedFiles are provided", async () => {
      await enrichment.updateEnrichmentMarker("test_collection", {
        status: "in_progress",
        totalFiles: 200,
        processedFiles: 50,
      });

      expect(qdrant.setPayload).toHaveBeenCalledWith(
        "test_collection",
        {
          enrichment: expect.objectContaining({
            status: "in_progress",
            totalFiles: 200,
            processedFiles: 50,
            percentage: 25,
          }),
        },
        expect.any(Object),
      );
    });

    it("should handle setPayload error gracefully in updateEnrichmentMarker", async () => {
      qdrant.setPayload.mockRejectedValueOnce(new Error("Qdrant marker error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Should not throw
      await enrichment.updateEnrichmentMarker("test_collection", {
        status: "in_progress",
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Failed to update marker:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("applyFileMetadata early return when gitLogResult is null", () => {
    it("should return early from onChunksStored when git log result is null (no prefetch)", async () => {
      // Do NOT call prefetchGitLog — gitLogResult stays null
      // But we need gitLogFailed to be false, so we simulate a scenario where
      // the enrichment module is in a fresh state without any prefetch
      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);

      // onChunksStored checks gitLogFailed first (which is false by default),
      // then checks gitLogResult (which is null) — so it queues the batch
      enrichment.onChunksStored("test_collection", repoDir, items);

      // batchSetPayload should NOT have been called
      expect(qdrant.batchSetPayload).not.toHaveBeenCalled();
    });
  });

  describe("applyFileMetadata batchSetPayload error handler", () => {
    it("should log error when batchSetPayload fails during file metadata apply", async () => {
      const fileMap = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      qdrant.batchSetPayload.mockRejectedValue(new Error("batchSetPayload connection error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      await enrichment.awaitCompletion("test_collection");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] batchSetPayload failed:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("prefetchGitLog error catch block", () => {
    it("should set gitLogFailed, record durationMs, and discard pending batches on error", async () => {
      mockBuildFileMetadataMap.mockRejectedValue(new Error("fatal: not a git repository"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir, "test_collection");

      // Queue a batch BEFORE the error resolves
      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // gitLogFailed should prevent any batch processing
      expect(qdrant.batchSetPayload).not.toHaveBeenCalled();
      expect(metrics.prefetchDurationMs).toBeGreaterThanOrEqual(0);

      // Error should have been logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Git log prefetch failed:"),
        expect.stringContaining("fatal: not a git repository"),
      );

      consoleSpy.mockRestore();
    });

    it("should handle non-Error objects in prefetch catch block", async () => {
      mockBuildFileMetadataMap.mockRejectedValue("string error");

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir);

      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics.prefetchDurationMs).toBeGreaterThanOrEqual(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Git log prefetch failed:"),
        "string error",
      );

      consoleSpy.mockRestore();
    });
  });

  describe("startChunkChurn main error handler", () => {
    it("should handle buildChunkChurnMap rejection gracefully", async () => {
      mockBuildFileMetadataMap.mockResolvedValue(new Map());
      mockBuildChunkChurnMap.mockRejectedValue(new Error("chunk churn explosion"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const chunkMap = new Map<string, ChunkLookupEntry[]>([
        [`${repoDir}/a.ts`, [{ chunkId: "chunk-0", startLine: 1, endLine: 10 }]],
      ]);
      enrichment.startChunkChurn("test_collection", repoDir, chunkMap);

      await new Promise((r) => setTimeout(r, 100));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] Chunk churn failed:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("backfillMissedFiles", () => {
    it("should backfill metadata for files not in the main git log window", async () => {
      // Git log returns only "a.ts" — "b.ts" will be missed
      const fileMap = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      // Backfill returns data for "b.ts"
      const backfillData = new Map([
        [
          "b.ts",
          {
            commits: [{ sha: "def", author: "Bob", authorEmail: "b@t.com", timestamp: 1690000000, body: "add b" }],
            linesAdded: 5,
            linesDeleted: 0,
          },
        ],
      ]);
      mockBuildFileMetadataForPaths.mockResolvedValue(backfillData);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Send chunks for both a.ts (matched) and b.ts (missed -> will be backfilled)
      const items = makeChunkItems([`${repoDir}/a.ts`, `${repoDir}/b.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // buildFileMetadataForPaths should have been called with the missed path
      expect(mockBuildFileMetadataForPaths).toHaveBeenCalledWith(
        expect.any(String), // repoRoot
        ["b.ts"], // missed paths
        expect.any(Number), // timeoutMs
      );

      // After backfill: b.ts was backfilled so matchedFiles increases, missedFiles decreases
      expect(metrics.matchedFiles).toBe(2); // a.ts (original) + b.ts (backfilled)
      expect(metrics.missedFiles).toBe(0); // b.ts was backfilled

      // batchSetPayload should have been called for backfill as well
      expect(qdrant.batchSetPayload).toHaveBeenCalled();
    });

    it("should handle backfill failure gracefully", async () => {
      // Git log returns nothing — all files miss
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Backfill itself fails
      mockBuildFileMetadataForPaths.mockRejectedValue(new Error("backfill timeout"));

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      // Should not throw
      const metrics = await enrichment.awaitCompletion("test_collection");

      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
      // File still missed since backfill failed
      expect(metrics.missedFiles).toBe(1);
    });

    it("should skip backfill when no files were missed", async () => {
      // Git log has all files
      const fileMap = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataMap.mockResolvedValue(fileMap);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      await enrichment.awaitCompletion("test_collection");

      // buildFileMetadataForPaths should NOT have been called
      expect(mockBuildFileMetadataForPaths).not.toHaveBeenCalled();
    });

    it("should handle partial backfill when some files still have no git data", async () => {
      // Git log returns nothing
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Backfill returns data for only one of the two missed files
      const backfillData = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataForPaths.mockResolvedValue(backfillData);

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      // Both a.ts and b.ts are missed
      const items = makeChunkItems([`${repoDir}/a.ts`, `${repoDir}/b.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      const metrics = await enrichment.awaitCompletion("test_collection");

      // a.ts was backfilled, b.ts was not
      expect(metrics.matchedFiles).toBe(1); // a.ts backfilled
      expect(metrics.missedFiles).toBe(1); // b.ts still missed
    });

    it("should handle batchSetPayload error during backfill", async () => {
      // Git log returns nothing
      mockBuildFileMetadataMap.mockResolvedValue(new Map());

      // Backfill returns data
      const backfillData = new Map([
        [
          "a.ts",
          {
            commits: [{ sha: "abc", author: "Alice", authorEmail: "a@t.com", timestamp: 1700000000, body: "init" }],
            linesAdded: 10,
            linesDeleted: 2,
          },
        ],
      ]);
      mockBuildFileMetadataForPaths.mockResolvedValue(backfillData);

      // batchSetPayload fails during backfill
      qdrant.batchSetPayload.mockRejectedValue(new Error("Qdrant backfill batch error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      enrichment.prefetchGitLog(repoDir);
      await new Promise((r) => setTimeout(r, 10));

      const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
      enrichment.onChunksStored("test_collection", repoDir, items);

      // Should not throw
      const metrics = await enrichment.awaitCompletion("test_collection");
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);

      // Error should have been logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[EnrichmentModule] backfill batchSetPayload failed:"),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it("should respect GIT_BACKFILL_TIMEOUT_MS env variable", async () => {
      const originalEnv = process.env.GIT_BACKFILL_TIMEOUT_MS;
      process.env.GIT_BACKFILL_TIMEOUT_MS = "5000";

      try {
        mockBuildFileMetadataMap.mockResolvedValue(new Map());
        mockBuildFileMetadataForPaths.mockResolvedValue(new Map());

        enrichment.prefetchGitLog(repoDir);
        await new Promise((r) => setTimeout(r, 10));

        const items = makeChunkItems([`${repoDir}/a.ts`], repoDir);
        enrichment.onChunksStored("test_collection", repoDir, items);

        await enrichment.awaitCompletion("test_collection");

        // Should have passed 5000 as timeout
        expect(mockBuildFileMetadataForPaths).toHaveBeenCalledWith(expect.any(String), expect.any(Array), 5000);
      } finally {
        if (originalEnv !== undefined) {
          process.env.GIT_BACKFILL_TIMEOUT_MS = originalEnv;
        } else {
          delete process.env.GIT_BACKFILL_TIMEOUT_MS;
        }
      }
    });
  });
});
