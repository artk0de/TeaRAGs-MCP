import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbeddingModelMismatchError } from "../../../../src/core/adapters/embeddings/errors.js";
import { EmbeddingModelGuard } from "../../../../src/core/adapters/qdrant/embedding-model-guard.js";
import { INDEXING_METADATA_ID } from "../../../../src/core/contracts/constants.js";

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

  describe("marker width follows the collection, not the configured guess", () => {
    // The guard is constructed at bootstrap with the model registry's guess. When
    // that guess is wrong the marker upsert is rejected, the guard caches null and
    // disables ITSELF — so two models can then be mixed in one collection. Its own
    // marker must therefore be sized from the collection it writes into.
    it("sizes the marker from the collection's vector size", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: false, vectorSize: 1024 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 768);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPoints.mock.calls[0];
      expect(points[0].vector).toHaveLength(1024);
    });

    it("sizes the hybrid marker from the collection's vector size", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true, vectorSize: 1024 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 768);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPointsWithSparse.mock.calls[0];
      expect(points[0].vector).toHaveLength(1024);
    });

    it("falls back to the configured dimensions when the collection reports none", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: false, vectorSize: 0 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 384);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPoints.mock.calls[0];
      expect(points[0].vector).toHaveLength(384);
    });

    it("reports the collection it stopped guarding when marker access fails", async () => {
      // Self-disabling is deliberate — an unreachable Qdrant must not block search.
      // But it must never be inaudible: this is the moment model mixing becomes
      // possible, so it is reported regardless of debug mode.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      qdrant.getPoint.mockRejectedValue(new Error("qdrant down"));
      const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);

      await expect(guard.ensureMatch("col")).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("col"), expect.anything());
      consoleError.mockRestore();
    });
  });
});
