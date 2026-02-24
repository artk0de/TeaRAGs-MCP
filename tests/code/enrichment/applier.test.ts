import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentApplier } from "../../../src/core/ingest/pipeline/enrichment/applier.js";

describe("EnrichmentApplier", () => {
  let mockQdrant: any;
  let applier: EnrichmentApplier;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
    };
    applier = new EnrichmentApplier(mockQdrant);
  });

  describe("applyFileMetadata", () => {
    it("writes payload under { [key]: { file: data } } structure", async () => {
      await applier.applyFileMetadata(
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

      await applier.applyFileMetadata(
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
      await applier.applyFileMetadata(
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
      await applier.applyFileMetadata("test-collection", "git", new Map([["src/a.ts", { x: 1 }]]), "/repo", [
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

  describe("applyChunkMetadata", () => {
    it("writes payload under { [key]: { chunk: overlay } } structure", async () => {
      const chunkMetadata = new Map([["src/index.ts", new Map([["chunk-1", { commitCount: 3, churnRatio: 0.5 }]])]]);

      const applied = await applier.applyChunkMetadata("test-collection", "git", chunkMetadata);

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
      const applied = await applier.applyChunkMetadata("test-collection", "git", new Map());
      expect(applied).toBe(0);
      expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
    });
  });
});
