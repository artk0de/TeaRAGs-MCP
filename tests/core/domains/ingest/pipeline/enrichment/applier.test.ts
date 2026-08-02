import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EnrichmentApplier,
  type EnrichmentApplyEvent,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

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

    it("counts policy-skipped files as ignored, not missed, and writes no stamp", async () => {
      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map(), // no overlay — schema.rb was skipped by policy
        "/repo",
        [
          {
            chunkId: "g1",
            chunk: { metadata: { filePath: "/repo/db/schema.rb" }, startLine: 1, endLine: 16 },
          } as any,
          {
            chunkId: "m1",
            chunk: { metadata: { filePath: "/repo/src/missing.ts" }, startLine: 1, endLine: 50 },
          } as any,
        ],
        undefined,
        "2026-06-05T00:00:00Z", // enrichedAt set — missed files would normally be stamped
        (rel) => rel === "db/schema.rb", // policy: schema.rb is ignored
      );

      // schema.rb → ignored (not missed, no chunk refs tracked for backfill).
      expect(applier.ignoredFiles).toBe(1);
      expect(applier.missedFiles).toBe(1); // only the genuine miss
      expect(applier.getMissedFileChunks().has("db/schema.rb")).toBe(false);
      expect(applier.getMissedFileChunks().has("src/missing.ts")).toBe(true);
      // No stamp written for the ignored file → it carries no git payload.
      const allOps = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) => c[1] ?? []);
      const stampedPoints = allOps.flatMap((op: any) => op.points ?? []);
      expect(stampedPoints).not.toContain("g1");
    });

    it("withholds the chunk-level enrichedAt stamp when policy declines that file at chunk level", async () => {
      // A brand-new markdown doc. Git enriches it at FILE level ("file-only")
      // but never at chunk level, and with no commits behind it yet it lands in
      // the MISSED branch — which used to bare-stamp `git.chunk.enrichedAt` on
      // it. ChunkPhase now writes `git.chunk.skippedAs` for the same point, and
      // the two terminal markers must stay mutually exclusive
      // (bd tea-rags-mcp-okra9), so the file-level stamp goes out alone.
      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map(), // no overlay — the doc has no git history yet
        "/repo",
        [
          {
            chunkId: "d1",
            chunk: { metadata: { filePath: "/repo/docs/guide.md" }, startLine: 1, endLine: 20 },
          } as any,
        ],
        undefined,
        "2026-06-05T00:00:00Z",
        (_rel, level) => level === "chunk", // policy: owed at file level, declined at chunk level
      );

      // Still a genuine miss at file level — backfill must keep seeing it.
      expect(applier.missedFiles).toBe(1);
      const allOps = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) => c[1] ?? []);
      expect(allOps.filter((op: any) => op.key === "git.file")).toHaveLength(1);
      expect(allOps.filter((op: any) => op.key === "git.chunk")).toHaveLength(0);
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

    it("records a genuine miss in missedPathSamples, capping the sample at 10", async () => {
      // 12 distinct source files, none with an overlay and none ignored → all
      // genuine misses. missedFiles counts every one, but missedPathSamples is a
      // bounded debug sample capped at MISSED_PATH_SAMPLE_LIMIT (10): the first
      // paths land in the sample, the overflow is counted but not sampled.
      const items = Array.from({ length: 12 }, (_, i) => ({
        chunkId: `c${i}`,
        chunk: { metadata: { filePath: `/repo/src/f${i}.ts` }, startLine: 1, endLine: 10 },
      })) as any[];

      await applier.applyFileSignals("test-collection", "git", new Map(), "/repo", items);

      expect(applier.missedFiles).toBe(12);
      // The first missed path is captured in the bounded sample...
      expect(applier.missedPathSamples).toContain("src/f0.ts");
      // ...but the sample never grows past the cap of 10.
      expect(applier.missedPathSamples).toHaveLength(10);
    });

    it("splits a >100-op file-apply into batches of at most BATCH_SIZE (100), all applied", async () => {
      // One MATCHED file with 101 chunks → 101 file-level ops → two Qdrant writes:
      // a full 100 then the remaining 1. Guards the applyFileSignals batch-slicing
      // loop specifically (the applyChunkSignals overflow path is pinned separately).
      const items = Array.from({ length: 101 }, (_, i) => ({
        chunkId: `c${i}`,
        chunk: { metadata: { filePath: "/repo/src/big.ts" }, endLine: i + 1 },
      })) as any[];

      await applier.applyFileSignals(
        "test-collection",
        "git",
        new Map([["src/big.ts", { commitCount: 7 }]]),
        "/repo",
        items,
      );

      expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(2);
      expect(mockQdrant.batchSetPayload.mock.calls[0][1]).toHaveLength(100);
      expect(mockQdrant.batchSetPayload.mock.calls[1][1]).toHaveLength(1);
      // All 101 point-ops were written — none dropped by the split.
      const allPoints = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) =>
        (c[1] as any[]).flatMap((op) => op.points),
      );
      expect(allPoints).toHaveLength(101);
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

  // bd tea-rags-mcp-yl9tv — applyFinalizeFile (codegraph deferred path)
  // classified a missing overlay by OVERLAY PRESENCE, not by POLICY: any file
  // the deferred provider produced no overlay for was silently bare-stamped,
  // never counted ignored OR missed. Under fileConcurrency a marginal source
  // file (parse error, lost to the spill) thus flipped between "stamped" and
  // (in other paths) "ignored" run-to-run, swinging ignoredFiles 12<->32.
  // Classification must be a POLICY decision: "none"-scope files → ignored;
  // a genuine source-file gap → missed.
  describe("applyFinalizeFile policy-driven classification (yl9tv)", () => {
    it("counts a policy-skipped file as ignored, not a silent bare-stamp", async () => {
      // schema.rb has no overlay (deferred provider declined it) AND policy says
      // "none" → it must be classified ignored, never missed, no stamp written.
      await applier.applyFinalizeFile(
        "test-collection",
        "codegraph.symbols",
        new Map(), // no overlays produced
        new Map([["db/schema.rb", [{ chunkId: "g1", startLine: 1, endLine: 16 }]]]),
        undefined,
        "2026-06-05T00:00:00Z",
        (rel) => rel === "db/schema.rb", // policy: schema.rb is ignored
      );

      expect(applier.ignoredFiles).toBe(1);
      expect(applier.missedFiles).toBe(0);
      // Ignored file carries NO codegraph payload stamp.
      const allOps = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) => c[1] ?? []);
      const stampedPoints = allOps.flatMap((op: any) => op.points ?? []);
      expect(stampedPoints).not.toContain("g1");
    });

    it("counts a source file with no overlay as missed, not silently bare-stamped", async () => {
      // A real source file the provider produced no overlay for (e.g. dropped
      // under concurrency) must be a genuine MISS — tracked for backfill — not
      // an overlay-absence "ignored" and not an invisible bare-stamp.
      await applier.applyFinalizeFile(
        "test-collection",
        "codegraph.symbols",
        new Map(), // no overlays produced
        new Map([["src/lost.ts", [{ chunkId: "m1", startLine: 1, endLine: 40 }]]]),
        undefined,
        "2026-06-05T00:00:00Z",
        () => false, // policy: src/lost.ts is NOT ignored → genuine source file
      );

      expect(applier.ignoredFiles).toBe(0);
      expect(applier.missedFiles).toBe(1);
    });

    it("declines a file the policy rejects even when a stale overlay exists for it", async () => {
      // finalizeSignals reads a PERSISTED graph, so a run made after
      // `excludeTests` was turned on can still be handed an overlay for a spec
      // file indexed under the old config. Writing it would put `enrichedAt` on
      // a point FilePhase already stamped `skippedAs` — two terminal states on
      // one point (bd tea-rags-mcp-okra9). The policy decides, not the overlay.
      const applied = await applier.applyFinalizeFile(
        "test-collection",
        "codegraph.symbols",
        new Map([["spec/models/user_spec.rb", { fanIn: 3 }]]),
        new Map([["spec/models/user_spec.rb", [{ chunkId: "t1", startLine: 1, endLine: 30 }]]]),
        undefined,
        "2026-06-05T00:00:00Z",
        (rel) => rel.startsWith("spec/"), // policy: tests are declined
      );

      expect(applied).toBe(0);
      expect(applier.ignoredFiles).toBe(1);
      expect(applier.missedFiles).toBe(0);
      const allOps = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) => c[1] ?? []);
      expect(allOps.flatMap((op: any) => op.points ?? [])).not.toContain("t1");
    });
  });

  describe("onApply cumulative progress events", () => {
    it("emits file-level applied as a Set-deduped cumulative — same relPath across two batches counts once", async () => {
      const events: EnrichmentApplyEvent[] = [];
      applier.onApply = (e) => events.push(e);
      const overlay = new Map([["src/a.ts", { commitCount: 3 }]]);

      // Batch 1 — src/a.ts
      await applier.applyFileSignals("test-collection", "git", overlay, "/repo", [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
      ]);
      // Batch 2 — same relPath, different chunk
      await applier.applyFileSignals("test-collection", "git", overlay, "/repo", [
        { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 20 } } as any,
      ]);

      const fileApplied = events.filter((e) => e.level === "file" && e.providerKey === "git").map((e) => e.applied);
      // One event per batch; cumulative + Set-deduped → the re-seen file stays at 1.
      expect(fileApplied).toEqual([1, 1]);
    });

    it("emits chunk-level applied as a running sum across batches — 3 then 5", async () => {
      const events: EnrichmentApplyEvent[] = [];
      applier.onApply = (e) => events.push(e);

      // Batch 1 — 3 chunk overlays
      await applier.applyChunkSignals(
        "test-collection",
        "git",
        new Map([
          [
            "src/a.ts",
            new Map([
              ["a1", { churn: 0.1 }],
              ["a2", { churn: 0.2 }],
              ["a3", { churn: 0.3 }],
            ]),
          ],
        ]),
      );
      // Batch 2 — 2 chunk overlays
      await applier.applyChunkSignals(
        "test-collection",
        "git",
        new Map([
          [
            "src/b.ts",
            new Map([
              ["b1", { churn: 0.4 }],
              ["b2", { churn: 0.5 }],
            ]),
          ],
        ]),
      );

      const chunkApplied = events.filter((e) => e.level === "chunk" && e.providerKey === "git").map((e) => e.applied);
      // Running sum, NOT a per-batch delta: 3, then 3 + 2 = 5.
      expect(chunkApplied).toEqual([3, 5]);
    });
  });
});
