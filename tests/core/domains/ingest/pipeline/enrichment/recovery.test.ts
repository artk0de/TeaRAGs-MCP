import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";

describe("EnrichmentRecovery", () => {
  let mockQdrant: {
    scrollFiltered: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
    batchSetPayload: ReturnType<typeof vi.fn>;
    countPoints: ReturnType<typeof vi.fn>;
  };
  let mockProvider: {
    key: string;
    resolveRoot: ReturnType<typeof vi.fn>;
    buildFileSignals: ReturnType<typeof vi.fn>;
    buildChunkSignals: ReturnType<typeof vi.fn>;
    fileSignalTransform: undefined;
  };
  let mockApplier: {
    applyFileSignals: ReturnType<typeof vi.fn>;
    applyChunkSignals: ReturnType<typeof vi.fn>;
  };
  let recovery: EnrichmentRecovery;

  beforeEach(() => {
    mockQdrant = {
      scrollFiltered: vi.fn().mockResolvedValue([]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      fileSignalTransform: undefined,
    };
    mockApplier = {
      applyFileSignals: vi.fn().mockResolvedValue(undefined),
      applyChunkSignals: vi.fn().mockResolvedValue(0),
    };
    recovery = new EnrichmentRecovery(mockQdrant as any, mockApplier as any);
  });

  describe("recoverFileLevel", () => {
    it("builds filePath with trailing slash on root correctly", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
      ]);
      // resolveRoot returns path with trailing slash
      mockProvider.resolveRoot.mockReturnValue("/repo/");

      await recovery.recoverFileLevel("test-collection", "/repo", mockProvider as any, "2026-01-01T00:00:00Z");

      // applyFileSignals should be called with items containing filePath=/repo/src/foo.ts
      const applierCall = mockApplier.applyFileSignals.mock.calls[0];
      const items = applierCall[4];
      expect(items[0].chunk.metadata.filePath).toBe("/repo/src/foo.ts");
    });

    it("builds filePath with slash joining when root has no trailing slash", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
      ]);
      // resolveRoot returns path without trailing slash
      mockProvider.resolveRoot.mockReturnValue("/repo");

      await recovery.recoverFileLevel("test-collection", "/repo", mockProvider as any, "2026-01-01T00:00:00Z");

      const applierCall = mockApplier.applyFileSignals.mock.calls[0];
      const items = applierCall[4];
      expect(items[0].chunk.metadata.filePath).toBe("/repo/src/foo.ts");
    });

    it("handles points missing relativePath (skips them)", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts" } },
        { id: "chunk-no-path", payload: {} }, // no relativePath — should be skipped
      ]);

      const result = await recovery.recoverFileLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      // Only one valid chunk processed
      expect(result.recoveredChunks).toBe(1);
    });

    it("scrolls for chunks missing file enrichedAt, calls buildFileSignals with unique paths", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
        { id: "chunk-2", payload: { relativePath: "src/foo.ts", startLine: 11, endLine: 20 } },
        { id: "chunk-3", payload: { relativePath: "src/bar.ts", startLine: 1, endLine: 5 } },
      ]);

      const result = await recovery.recoverFileLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(mockQdrant.scrollFiltered).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          must_not: expect.arrayContaining([
            expect.objectContaining({ key: "_type", match: { value: "indexing_metadata" } }),
          ]),
        }),
        expect.any(Number),
        undefined,
      );

      expect(mockProvider.buildFileSignals).toHaveBeenCalledWith("/repo", {
        paths: expect.arrayContaining(["src/foo.ts", "src/bar.ts"]),
      });

      expect(result.recoveredFiles).toBe(2);
      expect(result.recoveredChunks).toBe(3);
    });

    it("returns zeros and skips buildFileSignals when no unenriched chunks", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([]);

      const result = await recovery.recoverFileLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(mockProvider.buildFileSignals).not.toHaveBeenCalled();
      expect(mockApplier.applyFileSignals).not.toHaveBeenCalled();
      expect(result.recoveredFiles).toBe(0);
      expect(result.recoveredChunks).toBe(0);
      expect(result.remainingUnenriched).toBe(0);
    });

    it("catches buildFileSignals errors and returns remainingUnenriched > 0", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
      ]);
      mockProvider.buildFileSignals.mockRejectedValue(new Error("git failure"));

      const result = await recovery.recoverFileLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(result.remainingUnenriched).toBe(1);
      expect(result.recoveredFiles).toBe(0);
    });
  });

  describe("recoverChunkLevel", () => {
    it("scrolls for chunks missing chunk enrichedAt, calls buildChunkSignals with chunkMap", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
        { id: "chunk-2", payload: { relativePath: "src/bar.ts", startLine: 5, endLine: 15 } },
      ]);
      mockApplier.applyChunkSignals.mockResolvedValue(2);

      const result = await recovery.recoverChunkLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith("/repo", expect.any(Map));

      const chunkMapArg: Map<string, { chunkId: string; startLine: number; endLine: number }[]> =
        mockProvider.buildChunkSignals.mock.calls[0][1];
      expect(chunkMapArg.has("src/foo.ts")).toBe(true);
      expect(chunkMapArg.has("src/bar.ts")).toBe(true);
      expect(chunkMapArg.get("src/foo.ts")?.[0].chunkId).toBe("chunk-1");

      expect(result.recoveredChunks).toBe(2);
    });

    it("returns zeros and skips buildChunkSignals when no unenriched chunks", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([]);

      const result = await recovery.recoverChunkLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();
      expect(result.recoveredChunks).toBe(0);
      expect(result.remainingUnenriched).toBe(0);
    });

    it("catches buildChunkSignals errors and returns remainingUnenriched > 0", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
      ]);
      mockProvider.buildChunkSignals.mockRejectedValue(new Error("git failure"));

      const result = await recovery.recoverChunkLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(result.remainingUnenriched).toBe(1);
      expect(result.recoveredChunks).toBe(0);
    });

    it("groups multiple chunks from the same file into a single chunkMap entry", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } },
        { id: "chunk-2", payload: { relativePath: "src/foo.ts", startLine: 11, endLine: 20 } },
        { id: "chunk-3", payload: { relativePath: "src/foo.ts", startLine: 21, endLine: 30 } },
      ]);
      mockApplier.applyChunkSignals.mockResolvedValue(3);

      const result = await recovery.recoverChunkLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      const chunkMapArg: Map<string, unknown[]> = mockProvider.buildChunkSignals.mock.calls[0][1];
      // All 3 chunks are in one file → chunkMap has 1 entry with 3 chunks
      expect(chunkMapArg.size).toBe(1);
      expect(chunkMapArg.get("src/foo.ts")).toHaveLength(3);

      expect(result.recoveredFiles).toBe(1);
      expect(result.recoveredChunks).toBe(3);
    });

    it("tracks remainingUnenriched after successful recovery", async () => {
      mockQdrant.scrollFiltered
        .mockResolvedValueOnce([{ id: "chunk-1", payload: { relativePath: "src/foo.ts", startLine: 1, endLine: 10 } }])
        // Second scroll (countUnenriched) returns empty → all recovered
        .mockResolvedValueOnce([]);

      mockApplier.applyChunkSignals.mockResolvedValue(1);

      const result = await recovery.recoverChunkLevel(
        "test-collection",
        "/repo",
        mockProvider as any,
        "2026-01-01T00:00:00Z",
      );

      expect(result.remainingUnenriched).toBe(0);
    });

    it("handles chunks with undefined startLine/endLine (defaults to 0)", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts" } }, // no startLine/endLine
      ]);
      mockApplier.applyChunkSignals.mockResolvedValue(1);

      await recovery.recoverChunkLevel("test-collection", "/repo", mockProvider as any, "2026-01-01T00:00:00Z");

      const chunkMapArg: Map<string, { chunkId: string; startLine: number; endLine: number }[]> =
        mockProvider.buildChunkSignals.mock.calls[0][1];
      const chunks = chunkMapArg.get("src/foo.ts");
      expect(chunks?.[0].startLine).toBe(0);
      expect(chunks?.[0].endLine).toBe(0);
    });
  });

  describe("countUnenriched", () => {
    it("uses countPoints API instead of scrolling all points", async () => {
      mockQdrant.countPoints.mockResolvedValue(42);

      const count = await recovery.countUnenriched("test-collection", "git", "file");

      expect(count).toBe(42);
      expect(mockQdrant.countPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          must: expect.arrayContaining([{ is_empty: { key: "git.file.enrichedAt" } }]),
        }),
      );
    });

    it("builds correct filter for chunk level", async () => {
      mockQdrant.countPoints.mockResolvedValue(7);

      const count = await recovery.countUnenriched("test-collection", "git", "chunk");

      expect(count).toBe(7);
      expect(mockQdrant.countPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          must: expect.arrayContaining([{ is_empty: { key: "git.chunk.enrichedAt" } }]),
        }),
      );
    });

    it("returns zero when countPoints returns zero", async () => {
      mockQdrant.countPoints.mockResolvedValue(0);

      const count = await recovery.countUnenriched("test-collection", "git", "file");

      expect(count).toBe(0);
    });

    it("excludes indexing/schema metadata points from unenriched count", async () => {
      mockQdrant.countPoints.mockResolvedValue(0);

      await recovery.countUnenriched("test-collection", "git", "chunk");

      expect(mockQdrant.countPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          must_not: expect.arrayContaining([
            { key: "_type", match: { value: "indexing_metadata" } },
            { key: "_type", match: { value: "schema_metadata" } },
          ]),
        }),
      );
    });
  });

  describe("scrollUnenriched — configurable pageSize", () => {
    it("passes pageSize to scrollFiltered when provided", async () => {
      const customRecovery = new EnrichmentRecovery(mockQdrant as any, mockApplier as any, { scrollPageSize: 1000 });

      await customRecovery.recoverFileLevel("test-collection", "/repo", mockProvider as any, "2026-01-01T00:00:00Z");

      expect(mockQdrant.scrollFiltered).toHaveBeenCalledWith(
        "test-collection",
        expect.any(Object),
        expect.any(Number),
        1000,
      );
    });

    it("passes undefined pageSize when not configured", async () => {
      await recovery.recoverFileLevel("test-collection", "/repo", mockProvider as any, "2026-01-01T00:00:00Z");

      // Fourth arg should be undefined (no custom pageSize)
      const call = mockQdrant.scrollFiltered.mock.calls[0];
      expect(call[3]).toBeUndefined();
    });
  });
});
