import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbeddingModelMismatchError } from "../../../src/core/adapters/embeddings/errors.js";
import { INDEXING_METADATA_ID } from "../../../src/core/domains/ingest/constants.js";
import { EmbeddingModelGuard } from "../../../src/core/infra/embedding-model-guard.js";

function createMockQdrant(markerPayload?: Record<string, unknown> | null) {
  return {
    getPoint: vi
      .fn()
      .mockResolvedValue(
        markerPayload === null
          ? null
          : { id: INDEXING_METADATA_ID, payload: markerPayload ?? { embeddingModel: "model-a" } },
      ),
    setPayload: vi.fn().mockResolvedValue(undefined),
    addPoints: vi.fn().mockResolvedValue(undefined),
    addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    collectionExists: vi.fn().mockResolvedValue(true),
  } as any;
}

describe("EmbeddingModelGuard", () => {
  let qdrant: ReturnType<typeof createMockQdrant>;

  beforeEach(() => {
    qdrant = createMockQdrant();
  });

  it("should pass when model matches", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await expect(guard.ensureMatch("col")).resolves.toBeUndefined();
  });

  it("should throw EmbeddingModelMismatchError on mismatch", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-b", 768);
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    await expect(guard.ensureMatch("col")).rejects.toThrow(/model-a.*model-b/);
  });

  it("should cache result and not re-read Qdrant", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col");
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);
  });

  it("should backfill when marker exists but embeddingModel is missing", async () => {
    qdrant = createMockQdrant({ _type: "indexing_metadata", indexingComplete: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-x", 768);
    await guard.ensureMatch("col");

    expect(qdrant.setPayload).toHaveBeenCalledWith(
      "col",
      { embeddingModel: "model-x" },
      { points: [INDEXING_METADATA_ID] },
    );
  });

  it("should create marker when no marker point exists", async () => {
    qdrant = createMockQdrant(null);
    const guard = new EmbeddingModelGuard(qdrant, "model-y", 384);
    await guard.ensureMatch("col");

    expect(qdrant.addPoints).toHaveBeenCalledWith("col", [
      expect.objectContaining({
        id: INDEXING_METADATA_ID,
        payload: expect.objectContaining({ embeddingModel: "model-y" }),
      }),
    ]);
  });

  it("should create hybrid marker when collection is hybrid", async () => {
    qdrant = createMockQdrant(null);
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-z", 768);
    await guard.ensureMatch("col");

    expect(qdrant.addPointsWithSparse).toHaveBeenCalled();
    expect(qdrant.addPoints).not.toHaveBeenCalled();
  });

  it("should invalidate cache", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);

    guard.invalidate("col");
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(2);
  });

  it("should recordModel and use cache", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    guard.recordModel("col");
    await guard.ensureMatch("col");
    // No Qdrant read — cache hit from recordModel
    expect(qdrant.getPoint).not.toHaveBeenCalled();
  });

  it("should skip guard silently when Qdrant read fails", async () => {
    qdrant.getPoint.mockRejectedValue(new Error("qdrant down"));
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    // Should not throw
    await expect(guard.ensureMatch("col")).resolves.toBeUndefined();
  });

  it("should throw mismatch even when cached", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-b", 768);
    // First call reads and caches, throws mismatch
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    // Second call uses cache, still throws
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);
  });

  it("should create hybrid marker with sparse vector for hybrid collection", async () => {
    qdrant = createMockQdrant(null);
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-h", 768);
    await guard.ensureMatch("col");

    const call = qdrant.addPointsWithSparse.mock.calls[0];
    expect(call[1][0].sparseVector).toEqual({ indices: [], values: [] });
    expect(call[1][0].payload.embeddingModel).toBe("model-h");
  });

  it("should handle different collections independently", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col-1");

    // col-2 has different model
    qdrant.getPoint.mockResolvedValueOnce({
      id: INDEXING_METADATA_ID,
      payload: { embeddingModel: "model-other" },
    });

    await expect(guard.ensureMatch("col-2")).rejects.toThrow(EmbeddingModelMismatchError);
    // col-1 still cached and ok
    await expect(guard.ensureMatch("col-1")).resolves.toBeUndefined();
  });
});
