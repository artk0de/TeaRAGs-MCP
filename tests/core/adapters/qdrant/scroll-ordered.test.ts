import { describe, expect, it, vi } from "vitest";

import { scrollOrderedBy } from "../../../../src/core/adapters/qdrant/scroll.js";

function createMockQdrant(scrollResponse: unknown) {
  return {
    client: {
      scroll: vi.fn().mockResolvedValue(scrollResponse),
    },
  };
}

describe("scrollOrderedBy", () => {
  it("calls scroll with order_by, filter, and limit", async () => {
    const mockResponse = {
      points: [
        { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
        { id: "b", payload: { methodLines: 150, relativePath: "medium.ts" } },
      ],
      next_page_offset: null,
    };
    const qdrant = createMockQdrant(mockResponse);

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(qdrant.client.scroll).toHaveBeenCalledWith("test-collection", {
      limit: 10,
      offset: undefined,
      with_payload: true,
      with_vector: false,
      order_by: { key: "methodLines", direction: "desc" },
    });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].payload.methodLines).toBe(200);
  });

  it("passes filter when provided", async () => {
    const qdrant = createMockQdrant({ points: [], next_page_offset: null });

    await scrollOrderedBy(qdrant as never, "test-collection", { key: "git.file.ageDays", direction: "asc" }, 5, {
      must: [{ key: "language", match: { value: "typescript" } }],
    });

    expect(qdrant.client.scroll).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        filter: { must: [{ key: "language", match: { value: "typescript" } }] },
      }),
    );
  });

  it("returns empty array when no points match", async () => {
    const qdrant = createMockQdrant({ points: [], next_page_offset: null });

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(results).toEqual([]);
  });
});
