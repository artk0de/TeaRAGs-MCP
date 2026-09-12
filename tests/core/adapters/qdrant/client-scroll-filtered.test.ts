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

describe("QdrantManager.scrollBySymbolIds", () => {
  let manager: QdrantManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
  });

  it("returns chunks whose symbolId is in the set, in one call", async () => {
    mockScroll.mockResolvedValue({
      points: [
        { id: "uuid-a", payload: { symbolId: "A" } },
        { id: "uuid-c", payload: { symbolId: "C" } },
      ],
      next_page_offset: null,
    });

    const chunks = await manager.scrollBySymbolIds("test_collection", ["A", "C"]);

    const ids = chunks.map((c) => c.payload.symbolId).sort();
    expect(ids).toEqual(["A", "C"]);

    expect(mockScroll).toHaveBeenCalledTimes(1);
    // bd tea-rags-mcp-ivp12 — the OR over the id set is unchanged; each branch
    // now leads with the indexed text token (the id's last name segment, the
    // one token the `word` tokenizer reliably stores) so the exact `value`
    // condition is checked on candidates instead of on the whole collection.
    expect(mockScroll).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        filter: {
          should: ["A", "C"].map((id) => ({
            must: [
              { key: "symbolId", match: { text: id } },
              { key: "symbolId", match: { value: id } },
            ],
          })),
        },
        with_payload: true,
        with_vector: false,
      }),
    );
  });

  it("returns [] for an empty id list without querying", async () => {
    const chunks = await manager.scrollBySymbolIds("test_collection", []);
    expect(chunks).toEqual([]);
    expect(mockScroll).not.toHaveBeenCalled();
  });

  /**
   * An operator-named method has no text token: `symbolIdTextToken` reduces
   * `Comparable#==` to the empty string (the `=` suffixes are stripped) and
   * `Vec#<=>` to pure punctuation, and the `word` tokenizer stores neither. A
   * zero-token `match: { text }` matches nothing, so pairing it would make
   * trace_path silently drop those steps on a Ruby corpus — every hydration of
   * an operator method would come back empty and the path would render without
   * it. The branch therefore carries the exact `value` condition alone: a scan,
   * but the right answer.
   */
  it("carries the value condition alone for an operator-named symbol", async () => {
    mockScroll.mockResolvedValue({ points: [], next_page_offset: null });

    await manager.scrollBySymbolIds("test_collection", ["Comparable#==", "Vec#<=>", "Money#cents"]);

    expect(mockScroll.mock.calls[0][1].filter).toEqual({
      should: [
        { must: [{ key: "symbolId", match: { value: "Comparable#==" } }] },
        { must: [{ key: "symbolId", match: { value: "Vec#<=>" } }] },
        {
          must: [
            { key: "symbolId", match: { text: "cents" } },
            { key: "symbolId", match: { value: "Money#cents" } },
          ],
        },
      ],
    });
  });
});
