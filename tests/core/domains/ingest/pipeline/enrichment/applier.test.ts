import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

describe("EnrichmentApplier", () => {
  let mockQdrant: any;
  let applier: EnrichmentApplier;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
    };
    applier = new EnrichmentApplier(mockQdrant);
  });

  describe("applyFileSignals", () => {
    it("writes payload under { [key]: { file: data } } structure", async () => {
      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map([["src/index.ts", { commitCount: 5 }]]),
        "/repo",
        [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/index.ts" }, endLine: 100 },
          } as any,
        ],
      );

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: { git: { file: { commitCount: 5 } } },
            points: ["chunk-1"],
          }),
        ]),
      );
    });

    it("applies transform when provided", async () => {
      const transform = vi.fn((data: Record<string, unknown>, maxEndLine: number) => ({
        computed: true,
        lines: maxEndLine,
      }));

      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map([["src/index.ts", { raw: true }]]),
        "/repo",
        [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/index.ts" }, endLine: 42 },
          } as any,
        ],
        transform,
      );

      expect(transform).toHaveBeenCalledWith({ raw: true }, 42);
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: { git: { file: { computed: true, lines: 42 } } },
            points: ["chunk-1"],
          }),
        ]),
      );
    });

    it("tracks missed files for backfill", async () => {
      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map(), // empty — no file metadata
        "/repo",
        [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/missing.ts" }, endLine: 50 },
          } as any,
        ],
      );

      expect(applier.missedFiles).toBe(1);
      expect(applier.missedFileChunks.size).toBe(1);
      expect(applier.missedFileChunks.get("src/missing.ts")).toEqual([{ chunkId: "chunk-1", endLine: 50 }]);
    });

    it("groups chunks by file and batches Qdrant writes", async () => {
      await applier.applyFileSignals("test-collection", "git", new Map([["src/a.ts", { x: 1 }]]), "/repo", [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
        { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 20 } } as any,
      ]);

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(1);
      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      expect(ops).toHaveLength(2);
      expect(ops[0].points).toEqual(["c1"]);
      expect(ops[1].points).toEqual(["c2"]);
    });
  });

  describe("applyChunkSignals", () => {
    it("writes payload under { [key]: { chunk: overlay } } structure", async () => {
      const chunkMetadata = new Map([["src/index.ts", new Map([["chunk-1", { commitCount: 3, churnRatio: 0.5 }]])]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      expect(applied).toBe(1);
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: { git: { chunk: { commitCount: 3, churnRatio: 0.5 } } },
            points: ["chunk-1"],
          }),
        ]),
      );
    });

    it("returns 0 when no overlays", async () => {
      const applied = await applier.applyChunkSignals("test-collection", "git", new Map());
      expect(applied).toBe(0);
      expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
    });

    it("applies chunk overlays across multiple files", async () => {
      const chunkMetadata = new Map([
        [
          "src/a.ts",
          new Map([
            ["chunk-a1", { churn: 0.3 }],
            ["chunk-a2", { churn: 0.5 }],
          ]),
        ],
        ["src/b.ts", new Map([["chunk-b1", { churn: 0.1 }]])],
      ]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      expect(applied).toBe(3);
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(1);
      const batch = mockQdrant.batchSetPayload.mock.calls[0][1];
      expect(batch).toHaveLength(3);
      expect(batch[0]).toEqual({ payload: { git: { chunk: { churn: 0.3 } } }, points: ["chunk-a1"] });
      expect(batch[1]).toEqual({ payload: { git: { chunk: { churn: 0.5 } } }, points: ["chunk-a2"] });
      expect(batch[2]).toEqual({ payload: { git: { chunk: { churn: 0.1 } } }, points: ["chunk-b1"] });
    });

    it("flushes batch when chunk count exceeds BATCH_SIZE (100)", async () => {
      // Create a single file with 150 chunk overlays to trigger batch overflow at 100
      const overlays = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < 150; i++) {
        overlays.set(`chunk-${i}`, { idx: i });
      }
      const chunkMetadata = new Map([["src/big.ts", overlays]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata as any);

      // Should have 2 batchSetPayload calls: one at 100, one for the remaining 50
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
      expect(mockQdrant.batchSetPayload.mock.calls[0][1]).toHaveLength(100);
      expect(mockQdrant.batchSetPayload.mock.calls[1][1]).toHaveLength(50);
      expect(applied).toBe(150);
    });

    it("handles error in mid-batch batchSetPayload without losing remaining chunks", async () => {
      // First call (overflow batch) fails, second call (remainder) succeeds
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("qdrant batch fail")).mockResolvedValueOnce(undefined);

      const overlays = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < 110; i++) {
        overlays.set(`chunk-${i}`, { idx: i });
      }
      const chunkMetadata = new Map([["src/big.ts", overlays]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata as any);

      // First batch of 100 failed (not counted), remainder of 10 succeeded
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
      expect(applied).toBe(10);
    });

    it("handles error in final chunk batch gracefully", async () => {
      // Only one batch (< 100 items), and it fails
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("final batch fail"));

      const chunkMetadata = new Map([["src/a.ts", new Map([["chunk-1", { churn: 0.2 }]])]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(1);
      expect(applied).toBe(0); // Failed, so not counted
    });
  });
});
