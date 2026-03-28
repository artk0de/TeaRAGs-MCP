import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";

describe("EnrichmentRecovery", () => {
  let mockQdrant: {
    scrollFiltered: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
    batchSetPayload: ReturnType<typeof vi.fn>;
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
          must_not: expect.arrayContaining([expect.objectContaining({ has_id: expect.any(Array) })]),
        }),
        expect.any(Number),
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

      expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith(
        "/repo",
        expect.any(Map),
      );

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
  });

  describe("countUnenriched", () => {
    it("returns count of unenriched file-level chunks", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts" } },
        { id: "chunk-2", payload: { relativePath: "src/bar.ts" } },
        { id: "chunk-3", payload: { relativePath: "src/baz.ts" } },
      ]);

      const count = await recovery.countUnenriched("test-collection", "git", "file");

      expect(count).toBe(3);
    });

    it("returns count of unenriched chunk-level chunks", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([
        { id: "chunk-1", payload: { relativePath: "src/foo.ts" } },
      ]);

      const count = await recovery.countUnenriched("test-collection", "git", "chunk");

      expect(count).toBe(1);
    });

    it("returns zero when nothing is unenriched", async () => {
      mockQdrant.scrollFiltered.mockResolvedValue([]);

      const count = await recovery.countUnenriched("test-collection", "git", "file");

      expect(count).toBe(0);
    });
  });
});
