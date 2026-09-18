import { afterEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Qdrant 1.18 serves GET /collections/{name}/memory (PR #8606). The typed JS
// SDK has no method for it, so the adapter issues a raw GET — these specs pin
// the request it sends and the shape it hands back.

function usage(disk: number, ram: number, cached = 0, expected = 0) {
  return { disk_bytes: disk, ram_bytes: ram, cached_bytes: cached, expected_cache_bytes: expected };
}

const liveShapedBody = {
  result: {
    total: usage(2_074_500_000, 77_800_000, 63_000_000, 208_100_000),
    vectors: [
      {
        name: "dense",
        storage: usage(206_557_714, 0, 0, 206_557_714),
        index: usage(1_515_493, 0, 0, 1_515_493),
        quantized: usage(108_172_395, 7_495_360),
      },
    ],
    sparse_vectors: [{ name: "text", storage: usage(178_423_290, 0), index: usage(6_155_912, 10_397_796) }],
    payload: usage(173_180_325, 0),
    payload_index: [
      { name: "git.file.commitCount", usage: usage(30_900_000, 2_400_000) },
      { name: "symbolId", usage: usage(115_300_000, 3_500_000) },
    ],
    other: { id_tracker: usage(816_278, 1_574_808) },
  },
  status: "ok",
  time: 0.19,
};

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("QdrantManager.getCollectionMemoryUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /collections/<name>/memory on the live url with the configured api key", async () => {
    const fetchMock = stubFetch({ ok: true, body: liveShapedBody });
    const manager = new QdrantManager("http://qdrant.example:6333", "secret-key");

    await manager.getCollectionMemoryUsage("code_abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://qdrant.example:6333/collections/code_abc/memory");
    expect(init.headers["api-key"]).toBe("secret-key");
  });

  it("maps every component of the response into bytes, payload indexes and other keyed by name", async () => {
    stubFetch({ ok: true, body: liveShapedBody });
    const manager = new QdrantManager("http://localhost:6333");

    const memory = await manager.getCollectionMemoryUsage("code_abc");

    const cell = (disk: number, ram: number, cached = 0, expected = 0) => ({
      diskBytes: disk,
      ramBytes: ram,
      cachedBytes: cached,
      expectedCacheBytes: expected,
    });
    expect(memory).toEqual({
      total: cell(2_074_500_000, 77_800_000, 63_000_000, 208_100_000),
      vectors: [
        {
          name: "dense",
          storage: cell(206_557_714, 0, 0, 206_557_714),
          index: cell(1_515_493, 0, 0, 1_515_493),
          quantized: cell(108_172_395, 7_495_360),
        },
      ],
      sparseVectors: [{ name: "text", storage: cell(178_423_290, 0), index: cell(6_155_912, 10_397_796) }],
      payload: cell(173_180_325, 0),
      payloadIndexes: [
        { name: "git.file.commitCount", usage: cell(30_900_000, 2_400_000) },
        { name: "symbolId", usage: cell(115_300_000, 3_500_000) },
      ],
      other: [{ name: "id_tracker", usage: cell(816_278, 1_574_808) }],
    });
  });

  it("leaves quantized off a vector the server reports without one", async () => {
    const body = structuredClone(liveShapedBody);
    const [dense] = body.result.vectors as Record<string, unknown>[];
    dense.quantized = null;
    stubFetch({ ok: true, body });
    const manager = new QdrantManager("http://localhost:6333");

    const memory = await manager.getCollectionMemoryUsage("code_abc");

    expect(memory?.vectors[0]).not.toHaveProperty("quantized");
  });

  it("returns undefined when the server has no memory endpoint (older Qdrant answers 404)", async () => {
    stubFetch({ ok: false, status: 404, body: { status: { error: "Not found" } } });
    const manager = new QdrantManager("http://localhost:6333");

    await expect(manager.getCollectionMemoryUsage("code_abc")).resolves.toBeUndefined();
  });

  it("returns undefined when the probe cannot reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const manager = new QdrantManager("http://localhost:6333");

    await expect(manager.getCollectionMemoryUsage("code_abc")).resolves.toBeUndefined();
  });

  it("returns undefined when the body carries no usable total", async () => {
    stubFetch({ ok: true, body: { result: { vectors: [] }, status: "ok" } });
    const manager = new QdrantManager("http://localhost:6333");

    await expect(manager.getCollectionMemoryUsage("code_abc")).resolves.toBeUndefined();
  });
});
