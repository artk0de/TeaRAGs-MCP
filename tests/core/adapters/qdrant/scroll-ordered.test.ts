import { describe, expect, it, vi } from "vitest";

import { scrollOrderedBy } from "../../../../src/core/adapters/qdrant/scroll.js";

function createMockQdrant(scrollResponse: { id: string | number; payload: Record<string, unknown> }[]) {
  return {
    scrollOrdered: vi.fn().mockResolvedValue(scrollResponse),
  };
}

describe("scrollOrderedBy", () => {
  it("delegates to qdrant.scrollOrdered with correct arguments", async () => {
    const mockPoints = [
      { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
      { id: "b", payload: { methodLines: 150, relativePath: "medium.ts" } },
    ];
    const qdrant = createMockQdrant(mockPoints);

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(qdrant.scrollOrdered).toHaveBeenCalledWith(
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
      undefined,
    );
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].payload.methodLines).toBe(200);
  });

  it("passes filter when provided", async () => {
    const qdrant = createMockQdrant([]);
    const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

    await scrollOrderedBy(qdrant as never, "test-collection", { key: "git.file.ageDays", direction: "asc" }, 5, filter);

    expect(qdrant.scrollOrdered).toHaveBeenCalledWith(
      "test-collection",
      { key: "git.file.ageDays", direction: "asc" },
      5,
      filter,
    );
  });

  it("returns empty array when no points match", async () => {
    const qdrant = createMockQdrant([]);

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(results).toEqual([]);
  });
});
