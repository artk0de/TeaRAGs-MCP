import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant JS client
const mockScroll = vi.fn();
const mockClient = {
  scroll: mockScroll,
  getCollections: vi.fn().mockResolvedValue({ collections: [] }),
};
vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

describe("QdrantManager.scrollFiltered", () => {
  let manager: QdrantManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
  });

  it("returns points matching filter with full payloads", async () => {
    mockScroll.mockResolvedValue({
      points: [
        {
          id: "uuid-1",
          payload: {
            symbolId: "Reranker#score",
            content: "function score() {}",
            relativePath: "src/reranker.ts",
            startLine: 10,
            endLine: 20,
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "Reranker#rerank",
            content: "function rerank() {}",
            relativePath: "src/reranker.ts",
            startLine: 30,
            endLine: 50,
          },
        },
      ],
      next_page_offset: null,
    });

    const filter = {
      must: [{ key: "symbolId", match: { text: "Reranker" } }],
    };
    const results = await manager.scrollFiltered("test_collection", filter, 100);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("uuid-1");
    expect(results[0].payload.symbolId).toBe("Reranker#score");
    expect(results[1].id).toBe("uuid-2");

    expect(mockScroll).toHaveBeenCalledWith("test_collection", {
      limit: 100,
      with_payload: true,
      with_vector: false,
      filter,
    });
  });

  it("paginates when next_page_offset is present", async () => {
    mockScroll
      .mockResolvedValueOnce({
        points: [{ id: "uuid-1", payload: { symbolId: "A" } }],
        next_page_offset: "uuid-1",
      })
      .mockResolvedValueOnce({
        points: [{ id: "uuid-2", payload: { symbolId: "B" } }],
        next_page_offset: null,
      });

    const results = await manager.scrollFiltered(
      "test_collection",
      { must: [{ key: "symbolId", match: { text: "test" } }] },
      100,
    );

    expect(results).toHaveLength(2);
    expect(mockScroll).toHaveBeenCalledTimes(2);
  });

  it("skips points with null payloads", async () => {
    mockScroll.mockResolvedValue({
      points: [
        { id: "uuid-1", payload: null },
        { id: "uuid-2", payload: { symbolId: "Valid" } },
      ],
      next_page_offset: null,
    });

    const results = await manager.scrollFiltered(
      "test_collection",
      { must: [{ key: "symbolId", match: { text: "test" } }] },
      100,
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("uuid-2");
  });
});
