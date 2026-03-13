import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEXING_METADATA_ID } from "../../../../../src/core/domains/ingest/constants.js";
import { storeIndexingMarker } from "../../../../../src/core/domains/ingest/pipeline/indexing-marker.js";

describe("storeIndexingMarker", () => {
  let mockQdrant: any;
  let mockEmbeddings: any;

  beforeEach(() => {
    mockQdrant = {
      setPayload: vi.fn().mockResolvedValue(undefined),
      getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
      addPoints: vi.fn().mockResolvedValue(undefined),
      addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
    };
    mockEmbeddings = {
      getDimensions: vi.fn().mockReturnValue(4),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("complete=false — start marker", () => {
    it("stores a dense marker when hybridEnabled=false", async () => {
      mockQdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: false });
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", false);

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "col",
        expect.arrayContaining([
          expect.objectContaining({
            id: INDEXING_METADATA_ID,
            payload: expect.objectContaining({ indexingComplete: false }),
          }),
        ]),
      );
      expect(mockQdrant.addPointsWithSparse).not.toHaveBeenCalled();
    });

    it("stores a hybrid marker when hybridEnabled=true", async () => {
      mockQdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", false);

      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalledWith(
        "col",
        expect.arrayContaining([
          expect.objectContaining({
            id: INDEXING_METADATA_ID,
            sparseVector: { indices: [], values: [] },
          }),
        ]),
      );
      expect(mockQdrant.addPoints).not.toHaveBeenCalled();
    });

    it("uses a zero vector of the correct dimension", async () => {
      mockEmbeddings.getDimensions.mockReturnValue(8);
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", false);

      const [, points] = (mockQdrant.addPoints as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(points[0].vector).toHaveLength(8);
      expect((points[0].vector as number[]).every((v) => v === 0)).toBe(true);
    });

    it("includes _type and startedAt in payload", async () => {
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", false);

      const [, points] = (mockQdrant.addPoints as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(points[0].payload._type).toBe("indexing_metadata");
      expect(typeof points[0].payload.startedAt).toBe("string");
    });
  });

  describe("complete=true — completion marker", () => {
    it("calls setPayload with indexingComplete=true", async () => {
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", true);

      expect(mockQdrant.setPayload).toHaveBeenCalledWith(
        "col",
        expect.objectContaining({ indexingComplete: true }),
        expect.objectContaining({ points: [INDEXING_METADATA_ID] }),
      );
      expect(mockQdrant.addPoints).not.toHaveBeenCalled();
    });

    it("falls back to addPoints when setPayload throws", async () => {
      mockQdrant.setPayload.mockRejectedValue(new Error("point not found"));
      await storeIndexingMarker(mockQdrant, mockEmbeddings, "col", true);

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "col",
        expect.arrayContaining([
          expect.objectContaining({
            id: INDEXING_METADATA_ID,
            payload: expect.objectContaining({ indexingComplete: true }),
          }),
        ]),
      );
    });
  });

  describe("error resilience", () => {
    it("swallows outer errors and resolves to undefined", async () => {
      mockQdrant.getCollectionInfo.mockRejectedValue(new Error("connection refused"));
      await expect(storeIndexingMarker(mockQdrant, mockEmbeddings, "col", false)).resolves.toBeUndefined();
    });
  });
});
