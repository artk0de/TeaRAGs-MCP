import { beforeEach, describe, expect, it, vi } from "vitest";

import { scrollAllPoints } from "../../../../src/core/adapters/qdrant/scroll.js";

// Minimal mock matching the shape scrollAllPoints depends on
function createMockQdrant() {
  return {
    client: {
      scroll: vi.fn(),
    },
  };
}

describe("scrollAllPoints", () => {
  let mockQdrant: ReturnType<typeof createMockQdrant>;

  beforeEach(() => {
    mockQdrant = createMockQdrant();
  });

  it("returns all points from a single page when next_page_offset is null", async () => {
    mockQdrant.client.scroll.mockResolvedValueOnce({
      points: [
        { id: "1", payload: { relativePath: "src/foo.ts", ageDays: 10 } },
        { id: "2", payload: { relativePath: "src/bar.ts", ageDays: 20 } },
      ],
      next_page_offset: null,
    });

    const result = await scrollAllPoints(mockQdrant as any, "test-collection");

    expect(mockQdrant.client.scroll).toHaveBeenCalledOnce();
    expect(mockQdrant.client.scroll).toHaveBeenCalledWith("test-collection", {
      limit: 1000,
      offset: undefined,
      with_payload: true,
      with_vector: false,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ payload: { relativePath: "src/foo.ts", ageDays: 10 } });
    expect(result[1]).toEqual({ payload: { relativePath: "src/bar.ts", ageDays: 20 } });
  });

  it("paginates across multiple pages until next_page_offset is null", async () => {
    mockQdrant.client.scroll
      .mockResolvedValueOnce({
        points: [
          { id: "1", payload: { relativePath: "a.ts" } },
          { id: "2", payload: { relativePath: "b.ts" } },
        ],
        next_page_offset: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        points: [{ id: "3", payload: { relativePath: "c.ts" } }],
        next_page_offset: 42,
      })
      .mockResolvedValueOnce({
        points: [{ id: "4", payload: { relativePath: "d.ts" } }],
        next_page_offset: null,
      });

    const result = await scrollAllPoints(mockQdrant as any, "my-collection");

    expect(mockQdrant.client.scroll).toHaveBeenCalledTimes(3);

    // First page: no offset
    expect(mockQdrant.client.scroll).toHaveBeenNthCalledWith(1, "my-collection", {
      limit: 1000,
      offset: undefined,
      with_payload: true,
      with_vector: false,
    });

    // Second page: offset from first response
    expect(mockQdrant.client.scroll).toHaveBeenNthCalledWith(2, "my-collection", {
      limit: 1000,
      offset: "cursor-page-2",
      with_payload: true,
      with_vector: false,
    });

    // Third page: numeric offset from second response
    expect(mockQdrant.client.scroll).toHaveBeenNthCalledWith(3, "my-collection", {
      limit: 1000,
      offset: 42,
      with_payload: true,
      with_vector: false,
    });

    expect(result).toHaveLength(4);
    expect(result.map((p) => p.payload.relativePath)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("returns empty array for a collection with no points", async () => {
    mockQdrant.client.scroll.mockResolvedValueOnce({
      points: [],
      next_page_offset: null,
    });

    const result = await scrollAllPoints(mockQdrant as any, "empty-collection");

    expect(mockQdrant.client.scroll).toHaveBeenCalledOnce();
    expect(result).toEqual([]);
  });

  it("skips points that have no payload", async () => {
    mockQdrant.client.scroll.mockResolvedValueOnce({
      points: [
        { id: "1", payload: { relativePath: "valid.ts" } },
        { id: "2" }, // no payload property
        { id: "3", payload: null }, // null payload
        { id: "4", payload: undefined }, // undefined payload
        { id: "5", payload: { relativePath: "also-valid.ts" } },
      ],
      next_page_offset: null,
    });

    const result = await scrollAllPoints(mockQdrant as any, "mixed-collection");

    expect(result).toHaveLength(2);
    expect(result[0].payload.relativePath).toBe("valid.ts");
    expect(result[1].payload.relativePath).toBe("also-valid.ts");
  });
});
