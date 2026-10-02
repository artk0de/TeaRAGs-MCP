/**
 * Two invariants every RANKED query shares (bd tea-rags-mcp-xi2r9, live probe):
 *
 * - it never ranks a service point: the indexing marker and the schema
 *   metadata point carry vectors, and in a small collection they placed 3rd and
 *   5th in semantic_search / hybrid_search / find_similar;
 * - a point id it is handed goes through the same mapping a write applies, so
 *   `find_similar positiveIds: ["chunk_…"]` addresses the point stored under
 *   that chunk id instead of failing with a 400 Bad Request.
 */
import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../../src/core/adapters/qdrant/errors.js";
import { toQdrantPointId } from "../../../../src/core/adapters/qdrant/point-id.js";
import { servicePointExclusions } from "../../../../src/core/adapters/qdrant/service-points.js";

function createManager(client: Record<string, unknown>, hybridEnabled = true): QdrantManager {
  const manager = new QdrantManager("http://localhost:6333");
  (manager as unknown as { client: unknown }).client = client;
  manager.getCollectionInfo = vi.fn().mockResolvedValue({ hybridEnabled });
  return manager;
}

const userFilter = { must: [{ key: "language", match: { value: "typescript" } }] };
const excluded = { ...userFilter, must_not: servicePointExclusions() };

describe("QdrantSearchExecutor — ranked queries", () => {
  it("search should exclude service points, with and without a caller filter", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const manager = createManager({ search });

    await manager.search("col", [0.1], 5);
    await manager.search("col", [0.1], 5, userFilter);

    expect(search.mock.calls[0][1].filter).toEqual({ must_not: servicePointExclusions() });
    expect(search.mock.calls[1][1].filter).toEqual(excluded);
  });

  it("queryGroups should exclude service points", async () => {
    const queryGroups = vi.fn().mockResolvedValue({ groups: [] });
    const manager = createManager({ queryGroups });

    await manager.queryGroups("col", [0.1], { groupBy: "relativePath", limit: 5, filter: userFilter });

    expect(queryGroups.mock.calls[0][1].filter).toEqual(excluded);
  });

  it("hybridSearch should exclude service points on every prefetch and on the fused query", async () => {
    const query = vi.fn().mockResolvedValue({ points: [] });
    const manager = createManager({ query });

    await manager.hybridSearch("col", [0.1], { indices: [1], values: [1] }, 10, userFilter, undefined, {
      must: [{ key: "symbolId", match: { text: "foo" } }],
    });

    const request = query.mock.calls[0][1];
    expect(request.filter).toEqual(excluded);
    expect(request.prefetch[0].filter).toEqual(excluded);
    expect(request.prefetch[1].filter).toEqual(excluded);
    expect(request.prefetch[2].filter.must[0]).toEqual(excluded);
  });

  it("query should exclude service points and map string ids as a write maps them", async () => {
    const query = vi.fn().mockResolvedValue({ points: [] });
    const manager = createManager({ query });

    await manager.query("col", {
      positive: ["chunk_e61bd876bd62659c", [0.1, 0.2]],
      negative: ["20054299-0bf6-2a2a-065d-fde15c6f8718"],
      limit: 5,
    });

    const request = query.mock.calls[0][1];
    expect(request.filter).toEqual({ must_not: servicePointExclusions() });
    expect(request.query.recommend.positive).toEqual([toQdrantPointId("chunk_e61bd876bd62659c"), [0.1, 0.2]]);
    expect(request.query.recommend.negative).toEqual(["20054299-0bf6-2a2a-065d-fde15c6f8718"]);
  });

  it("query should report an id Qdrant does not hold as a point-not-found, naming the caller's id", async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const manager = createManager({ query });

    const failure = manager.query("col", { positive: ["chunk_0000000000000000"], limit: 5 });

    await expect(failure).rejects.toBeInstanceOf(QdrantPointNotFoundError);
    await expect(failure).rejects.toThrow(/chunk_0000000000000000/);
  });
});
