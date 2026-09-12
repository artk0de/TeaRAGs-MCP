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

async function collect<T>(pages: AsyncGenerator<T[]>): Promise<T[][]> {
  const out: T[][] = [];
  for await (const page of pages) out.push(page);
  return out;
}

// bd tea-rags-mcp-a2ddb — the traversal `CodegraphPayloadHealer` runs on: the
// whole collection, once, with the payload narrowed to the few keys it reads.
// Filtering per file instead costs a full scan EACH time, because the live
// payload index on `relativePath` is `text` and does not serve `match.value`.
describe("QdrantManager.scrollPayloadPages", () => {
  let manager: QdrantManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
  });

  it("asks for the named payload keys only, and never for vectors", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "p1", payload: { symbolId: "Hub#serve" } }],
      next_page_offset: null,
    });

    await collect(manager.scrollPayloadPages("coll", ["relativePath", "symbolId", "codegraph"]));

    expect(mockScroll).toHaveBeenCalledWith("coll", {
      limit: 1000,
      offset: undefined,
      with_payload: { include: ["relativePath", "symbolId", "codegraph"] },
      with_vector: false,
    });
  });

  it("walks every page, driving the cursor off next_page_offset until it stops", async () => {
    mockScroll
      .mockResolvedValueOnce({ points: [{ id: "p1", payload: { symbolId: "a" } }], next_page_offset: "cursor-2" })
      .mockResolvedValueOnce({ points: [{ id: "p2", payload: { symbolId: "b" } }], next_page_offset: 42 })
      .mockResolvedValueOnce({ points: [{ id: "p3", payload: { symbolId: "c" } }], next_page_offset: null });

    const pages = await collect(manager.scrollPayloadPages("coll", ["symbolId"]));

    expect(pages.flat().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(mockScroll).toHaveBeenCalledTimes(3);
    expect(mockScroll.mock.calls[1][1].offset).toBe("cursor-2");
    expect(mockScroll.mock.calls[2][1].offset).toBe(42);
  });

  it("honours a caller-chosen page size", async () => {
    mockScroll.mockResolvedValue({ points: [], next_page_offset: null });

    await collect(manager.scrollPayloadPages("coll", ["symbolId"], 250));

    expect(mockScroll.mock.calls[0][1].limit).toBe(250);
  });

  // A page the server answers with nothing must not end the walk early — the
  // heal would then advance its baseline over points it never read.
  it("keeps walking past an empty page while the server still hands back a cursor", async () => {
    mockScroll
      .mockResolvedValueOnce({ points: [], next_page_offset: "cursor-2" })
      .mockResolvedValueOnce({ points: [{ id: "p9", payload: { symbolId: "z" } }], next_page_offset: null });

    const pages = await collect(manager.scrollPayloadPages("coll", ["symbolId"]));

    expect(mockScroll).toHaveBeenCalledTimes(2);
    expect(pages.flat().map((p) => p.id)).toEqual(["p9"]);
  });

  it("drops points the server returned without a payload", async () => {
    mockScroll.mockResolvedValue({
      points: [
        { id: "p1", payload: { symbolId: "a" } },
        { id: "p2", payload: null },
      ],
      next_page_offset: null,
    });

    const pages = await collect(manager.scrollPayloadPages("coll", ["symbolId"]));

    expect(pages.flat().map((p) => p.id)).toEqual(["p1"]);
  });
});
