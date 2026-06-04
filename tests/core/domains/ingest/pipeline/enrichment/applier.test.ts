import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

describe("EnrichmentApplier", () => {
  let mockQdrant: any;
  let applier: EnrichmentApplier;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
    };
    // baseDelayMs: 0 keeps retry-exercising tests instant (no real backoff sleep).
    applier = new EnrichmentApplier(mockQdrant, { baseDelayMs: 0 });
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
      expect(applier.getMissedFileChunks().size).toBe(1);
      expect(applier.getMissedFileChunks().get("src/missing.ts")).toEqual([{ chunkId: "chunk-1", endLine: 50 }]);
    });

    it("recovers a transient batchSetPayload failure via retry without throwing", async () => {
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("qdrant unavailable"));

      // Should not throw, and the retry lands the write (2 calls total).
      await expect(
        applier.applyFileSignals("test-collection", "git", new Map([["src/index.ts", { commitCount: 5 }]]), "/repo", [
          {
            chunkId: "chunk-1",
            chunk: { metadata: { filePath: "/repo/src/index.ts" }, startLine: 1, endLine: 100 },
          } as any,
        ]),
      ).resolves.toBeUndefined();

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
    });

    it("retries a transient file-apply failure so the write lands without residual", async () => {
      // A single transient Qdrant blip on the streaming file-apply batch must
      // NOT leave the file unenriched: the retry lands the write, and the file
      // is NOT queued for backfill (it already succeeded).
      const retryApplier = new EnrichmentApplier(mockQdrant, { baseDelayMs: 0 });
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValue(undefined);

      await retryApplier.applyFileSignals(
        "test-collection",
        "git",
        new Map([["src/a.ts", { commitCount: 5 }]]),
        "/repo",
        [{ chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 100 } } as any],
        undefined,
        "ts",
      );

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
      expect(retryApplier.matchedFiles).toBe(1);
      expect(retryApplier.missedFiles).toBe(0);
      expect(retryApplier.getMissedFileChunks().size).toBe(0);
    });

    it("queues a matched file for backfill when its file-apply write keeps failing", async () => {
      // Reproduces the degraded-status root cause: a persistent write failure on
      // a MATCHED file (git history exists) used to be swallowed silently, so the
      // chunk kept git.chunk signals but lost git.file.enrichedAt forever. Now the
      // residual lands in the missed-file tracker so backfill re-applies it.
      const retryApplier = new EnrichmentApplier(mockQdrant, { maxAttempts: 3, baseDelayMs: 0 });
      mockQdrant.batchSetPayload.mockRejectedValue(new Error("qdrant down"));

      await retryApplier.applyFileSignals(
        "test-collection",
        "git",
        new Map([["src/a.ts", { commitCount: 5 }]]),
        "/repo",
        [{ chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 100 } } as any],
        undefined,
        "ts",
      );

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(3); // exhausted budget
      expect(retryApplier.getMissedFileChunks().get("src/a.ts")).toEqual([
        { chunkId: "c1", startLine: 1, endLine: 100 },
      ]);
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

    it("retries a transient mid-batch failure so no chunks are lost", async () => {
      // First overflow batch's first attempt fails, its retry lands; the
      // remainder batch then succeeds. All 110 chunks end up applied.
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("qdrant batch fail")).mockResolvedValue(undefined);

      const overlays = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < 110; i++) {
        overlays.set(`chunk-${i}`, { idx: i });
      }
      const chunkMetadata = new Map([["src/big.ts", overlays]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata as any);

      // batch1: fail + retry-success (2 calls), batch2: success (1 call) = 3 total
      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(3);
      expect(applied).toBe(110);
    });

    it("does not count a chunk batch whose write exhausts the retry budget", async () => {
      // Persistent failure (every attempt throws) — the batch is not counted,
      // but the call does not throw and other batches proceed independently.
      mockQdrant.batchSetPayload.mockRejectedValue(new Error("qdrant down"));

      const chunkMetadata = new Map([["src/a.ts", new Map([["chunk-1", { churn: 0.2 }]])]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(3); // exhausted budget
      expect(applied).toBe(0);
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

    it("retries a transient final-batch failure so the single batch lands", async () => {
      // Only one batch (< 100 items); its first attempt fails, the retry lands.
      mockQdrant.batchSetPayload.mockRejectedValueOnce(new Error("final batch fail")).mockResolvedValue(undefined);

      const chunkMetadata = new Map([["src/a.ts", new Map([["chunk-1", { churn: 0.2 }]])]]);

      const applied = await applier.applyChunkSignals("test-collection", "git", chunkMetadata);

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
      expect(applied).toBe(1);
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

  describe("matchedFiles uniqueness across passes", () => {
    it("counts each file only once even when applied in two separate passes", async () => {
      const fileMetadata = new Map([
        ["src/a.ts", { commitCount: 3 }],
        ["src/b.ts", { commitCount: 5 }],
      ]);

      // Pass 1 — streaming apply: touches src/a.ts and src/b.ts
      await applier.applyFileSignals("test-collection", "git", fileMetadata, "/repo", [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
        { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/b.ts" }, endLine: 20 } } as any,
      ]);

      // Pass 2 — finalize/deferred apply: same files again (new chunks, same relPaths)
      await applier.applyFileSignals("test-collection", "git", fileMetadata, "/repo", [
        { chunkId: "c3", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 30 } } as any,
        { chunkId: "c4", chunk: { metadata: { filePath: "/repo/src/b.ts" }, endLine: 40 } } as any,
      ]);

      // Each unique file path should be counted exactly once, not twice
      expect(applier.matchedFiles).toBe(2);
    });

    it("counts unique files across applyFileSignals and applyFinalizeFile passes", async () => {
      const fileOverlays = new Map([["src/a.ts", { commitCount: 3 }]]);

      // Pass 1 — streaming apply via applyFileSignals
      await applier.applyFileSignals("test-collection", "git", fileOverlays, "/repo", [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
      ]);

      // Pass 2 — finalize apply via applyFinalizeFile (same relPath)
      await applier.applyFinalizeFile(
        "test-collection",
        "git",
        fileOverlays,
        new Map([["src/a.ts", [{ chunkId: "c2", startLine: 20, endLine: 30 }]]]),
      );

      // src/a.ts appeared in both passes — should count only once
      expect(applier.matchedFiles).toBe(1);
    });
  });
});
