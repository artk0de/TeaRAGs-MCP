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
            payload: { commitCount: 5 },
            points: ["chunk-1"],
            key: "git.file",
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
            payload: { computed: true, lines: 42 },
            points: ["chunk-1"],
            key: "git.file",
          }),
        ]),
      );
    });

    it("uses nested key path so file signals don't overwrite chunk signals", async () => {
      // This test prevents regression: without key="git.file", set_payload({ git: { file: ... } })
      // would overwrite the entire git object, destroying previously written git.chunk signals.
      await applier.applyFileSignals("test-collection", "git", new Map([["src/index.ts", { ageDays: 30 }]]), "/repo", [
        { chunkId: "chunk-1", chunk: { metadata: { filePath: "/repo/src/index.ts" }, endLine: 100 } } as any,
      ]);

      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      // MUST have key="git.file" — not payload={ git: { file: ... } }
      expect(ops[0].key).toBe("git.file");
      expect(ops[0].payload).toEqual({ ageDays: 30 });
      expect(ops[0].payload).not.toHaveProperty("git");
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

    it("catches batchSetPayload error in applyFileSignals without throwing", async () => {
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("qdrant unavailable"));

      // Should not throw even when Qdrant fails
      await expect(
        applier.applyFileSignals("test-collection", "git", new Map([["src/index.ts", { commitCount: 5 }]]), "/repo", [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/index.ts" }, endLine: 100 },
          } as any,
        ]),
      ).resolves.toBeUndefined();

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(1);
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
            payload: { commitCount: 3, churnRatio: 0.5 },
            points: ["chunk-1"],
            key: "git.chunk",
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
      expect(batch[0]).toEqual({ payload: { churn: 0.3 }, points: ["chunk-a1"], key: "git.chunk" });
      expect(batch[1]).toEqual({ payload: { churn: 0.5 }, points: ["chunk-a2"], key: "git.chunk" });
      expect(batch[2]).toEqual({ payload: { churn: 0.1 }, points: ["chunk-b1"], key: "git.chunk" });
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

    it("uses nested key path so chunk signals don't overwrite file signals", async () => {
      // This test prevents regression: without key="git.chunk", set_payload({ git: { chunk: ... } })
      // would overwrite the entire git object, destroying previously written git.file signals.
      const chunkMetadata = new Map([["src/a.ts", new Map([["chunk-1", { commitCount: 3 }]])]]);

      await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      // MUST have key="git.chunk" — not payload={ git: { chunk: ... } }
      expect(ops[0].key).toBe("git.chunk");
      // Payload is the overlay itself, not nested under git.chunk
      expect(ops[0].payload).toEqual({ commitCount: 3 });
      // If payload had { git: { chunk: ... } } without key, it would overwrite git.file
      expect(ops[0].payload).not.toHaveProperty("git");
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

  describe("enrichedAt timestamps", () => {
    it("should include git.file.enrichedAt in file signal batch payload", async () => {
      const ts = "2026-03-27T00:00:00.000Z";

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
        undefined,
        ts,
      );

      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      expect(ops[0].payload).toMatchObject({ commitCount: 5, enrichedAt: ts });
    });

    it("should include git.file.enrichedAt even for missed files (intentional skip)", async () => {
      const ts = "2026-03-27T00:00:00.000Z";

      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map(), // empty — no file metadata, all chunks are "missed"
        "/repo",
        [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/missing.ts" }, endLine: 50 },
          } as any,
        ],
        undefined,
        ts,
      );

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(1);
      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      expect(ops[0].payload).toEqual({ enrichedAt: ts });
      expect(ops[0].key).toBe("git.file");
      expect(ops[0].points).toEqual(["chunk-1"]);
    });

    it("stamps chunk-level enrichedAt for missed files (no git history)", async () => {
      const ts = "2026-03-27T00:00:00.000Z";

      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map(), // no file signals → file is missed
        "/repo",
        [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/missing.ts" }, endLine: 50 },
          } as any,
        ],
        undefined,
        ts,
      );

      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      // Must write BOTH file and chunk level enrichedAt, otherwise recovery keeps
      // reporting these chunks as unenriched forever.
      const keys = ops.map((op: any) => op.key).sort();
      expect(keys).toEqual(["git.chunk", "git.file"]);
      const chunkOp = ops.find((op: any) => op.key === "git.chunk");
      expect(chunkOp.payload).toEqual({ enrichedAt: ts });
      expect(chunkOp.points).toEqual(["chunk-1"]);
    });

    it("should include git.chunk.enrichedAt in chunk signal batch payload", async () => {
      const ts = "2026-03-27T00:00:00.000Z";

      const chunkMetadata = new Map([["src/index.ts", new Map([["chunk-1", { commitCount: 3 }]])]]);

      await applier.applyChunkSignals("test-collection", "git", chunkMetadata, ts);

      const ops = mockQdrant.batchSetPayload.mock.calls[0][1];
      expect(ops[0].payload).toMatchObject({ commitCount: 3, enrichedAt: ts });
    });
  });
});
