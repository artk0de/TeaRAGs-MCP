// tests/core/adapters/qdrant/query.test.ts
import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

const mockQuery = vi.fn();
const mockGetCollectionInfo = vi.fn();

function createManager(): QdrantManager {
  const manager = new QdrantManager("http://localhost:6333");
  (manager as any).client = { query: mockQuery };
  manager.getCollectionInfo = mockGetCollectionInfo;
  return manager;
}

describe("QdrantManager.query()", () => {
  it("calls client.query with recommend sub-query", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({
      points: [
        { id: "uuid-1", score: 0.95, payload: { relativePath: "src/a.ts" } },
        { id: "uuid-2", score: 0.85, payload: { relativePath: "src/b.ts" } },
      ],
    });

    const manager = createManager();
    const results = await manager.query("test_col", {
      positive: ["id-1", [0.1, 0.2, 0.3]],
      negative: ["id-2"],
      strategy: "best_score",
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      "test_col",
      expect.objectContaining({
        query: {
          recommend: {
            positive: ["id-1", [0.1, 0.2, 0.3]],
            negative: ["id-2"],
            strategy: "best_score",
          },
        },
        limit: 10,
        filter: { must: [{ key: "language", match: { value: "typescript" } }] },
        with_payload: true,
        with_vector: false,
      }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "uuid-1",
      score: 0.95,
      payload: { relativePath: "src/a.ts" },
    });
  });

  it("sets using='dense' for hybrid-enabled collections", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("hybrid_col", {
      positive: ["id-1"],
      limit: 5,
    });

    expect(mockQuery).toHaveBeenCalledWith(
      "hybrid_col",
      expect.objectContaining({
        using: "dense",
      }),
    );
  });

  it("omits using for non-hybrid collections", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("plain_col", {
      positive: ["id-1"],
      limit: 5,
    });

    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs.using).toBeUndefined();
  });

  it("handles empty results", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    const results = await manager.query("test_col", {
      positive: ["id-1"],
      limit: 5,
    });

    expect(results).toEqual([]);
  });

  it("passes offset when provided", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("test_col", {
      positive: ["id-1"],
      limit: 10,
      offset: 5,
    });

    expect(mockQuery).toHaveBeenCalledWith(
      "test_col",
      expect.objectContaining({
        offset: 5,
      }),
    );
  });
});
