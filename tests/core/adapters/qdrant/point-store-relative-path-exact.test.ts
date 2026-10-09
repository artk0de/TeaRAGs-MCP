/**
 * Path-membership in `QdrantPointStore` on both sides of the
 * `relativePathExact` gate (bd tea-rags-mcp-ejio7). A collection the gate
 * serves is addressed by keyword MatchAny groups on `relativePathExact`; one it
 * does not keeps the text+value pairs of `relativePath` — a keyword filter on a
 * collection whose backfill has not completed would silently miss points. The
 * Qdrant REST client is the only fake.
 */

import { describe, expect, it, vi } from "vitest";

import { QdrantConnection } from "../../../../src/core/adapters/qdrant/connection.js";
import { RELATIVE_PATHS_PER_KEYWORD_FILTER } from "../../../../src/core/adapters/qdrant/filters/relative-path-exact.js";
import { QdrantPointStore } from "../../../../src/core/adapters/qdrant/point-store.js";

type Condition = { key: string; match: { any?: string[]; text?: string; value?: string } };
type ScrollArgs = { filter: { must?: Condition[]; should?: { must: Condition[] }[] }; offset?: unknown };

function storeWith(served: boolean, scroll: (args: ScrollArgs) => Promise<unknown>) {
  const connection = new QdrantConnection("http://127.0.0.1:6333");
  const client = {
    scroll: vi.fn(async (_collection: string, args: ScrollArgs) => scroll(args)),
    delete: vi.fn(async (_collection: string, _args: unknown) => ({})),
  };
  connection.client = client as never;
  const gate = { isServed: vi.fn(async () => served) };
  return { store: new QdrantPointStore(connection, gate), client, gate };
}

const keywordPaths = (filter: ScrollArgs["filter"]): string[] => {
  expect(filter.must).toHaveLength(1);
  const [condition] = filter.must ?? [];
  expect(condition.key).toBe("relativePathExact");
  return condition.match.any ?? [];
};

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/file${i}.ts`);

describe("QdrantPointStore#deletePointsByPathsBatched on a collection carrying relativePathExact", () => {
  it("collects ids with keyword MatchAny groups that partition the path set", async () => {
    const { store, client, gate } = storeWith(true, async (args) => ({
      points: keywordPaths(args.filter).map((p) => ({ id: `id:${p}` })),
      next_page_offset: null,
    }));
    const all = paths(600);

    await store.deletePointsByPathsBatched("col", all, { batchSize: 10_000, concurrency: 1 });

    expect(gate.isServed).toHaveBeenCalledWith("col");
    const groups = client.scroll.mock.calls.map((call) => keywordPaths(call[1].filter));
    expect(groups).toHaveLength(Math.ceil(600 / RELATIVE_PATHS_PER_KEYWORD_FILTER));
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(RELATIVE_PATHS_PER_KEYWORD_FILTER);
    expect(groups.flat().sort()).toEqual([...all].sort());
    const deleted = client.delete.mock.calls.flatMap((call) => (call[1] as { points: string[] }).points);
    expect(deleted.sort()).toEqual(all.map((p) => `id:${p}`).sort());
  });

  it("follows a group's pagination to exhaustion", async () => {
    const { store, client } = storeWith(true, async (args) =>
      args.offset === undefined
        ? { points: [{ id: "p1" }, { id: "p2" }], next_page_offset: "o1" }
        : { points: [{ id: "p3" }], next_page_offset: null },
    );

    await store.deletePointsByPathsBatched("col", ["a.ts", "b.ts"], { batchSize: 10_000, concurrency: 1 });

    expect(client.scroll).toHaveBeenCalledTimes(2);
    expect(client.scroll.mock.calls[1][1].offset).toBe("o1");
    const deleted = client.delete.mock.calls.flatMap((call) => (call[1] as { points: string[] }).points);
    expect(deleted).toEqual(["p1", "p2", "p3"]);
  });

  it("names a path listed twice once", async () => {
    const { store, client } = storeWith(true, async () => ({ points: [], next_page_offset: null }));

    await store.deletePointsByPathsBatched("col", ["a.ts", "a.ts", "b.ts"], { batchSize: 10, concurrency: 1 });

    expect(keywordPaths(client.scroll.mock.calls[0][1].filter)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("QdrantPointStore#deletePointsByPathsBatched on a collection without it", () => {
  it("keeps one exact text+value pair per scroll and never names relativePathExact", async () => {
    const { store, client } = storeWith(false, async () => ({ points: [], next_page_offset: null }));

    await store.deletePointsByPathsBatched("col", ["a.ts", "b.ts"], { batchSize: 10, concurrency: 1 });

    expect(client.scroll).toHaveBeenCalledTimes(2);
    for (const call of client.scroll.mock.calls) {
      const must = call[1].filter.must ?? [];
      expect(must.map((c) => c.key)).toEqual(["relativePath", "relativePath"]);
    }
  });
});

describe("QdrantPointStore#deletePointsByPaths", () => {
  it("deletes by keyword MatchAny groups on a served collection, each request waiting", async () => {
    const { store, client } = storeWith(true, async () => ({ points: [], next_page_offset: null }));
    const all = paths(300);

    await store.deletePointsByPaths("col", all);

    const requests = client.delete.mock.calls.map((call) => call[1] as { wait: boolean; filter: ScrollArgs["filter"] });
    expect(requests).toHaveLength(Math.ceil(300 / RELATIVE_PATHS_PER_KEYWORD_FILTER));
    for (const request of requests) expect(request.wait).toBe(true);
    expect(requests.flatMap((r) => keywordPaths(r.filter)).sort()).toEqual([...all].sort());
  });

  it("keeps the should-of-pairs filter on an unserved collection", async () => {
    const { store, client } = storeWith(false, async () => ({ points: [], next_page_offset: null }));

    await store.deletePointsByPaths("col", ["a.ts"]);

    const request = client.delete.mock.calls[0][1] as { filter: ScrollArgs["filter"] };
    expect(request.filter.should).toEqual([
      {
        must: [
          { key: "relativePath", match: { text: "a.ts" } },
          { key: "relativePath", match: { value: "a.ts" } },
        ],
      },
    ]);
  });

  it("sends no request for an empty path set, served or not", async () => {
    const served = storeWith(true, async () => ({ points: [], next_page_offset: null }));
    const unserved = storeWith(false, async () => ({ points: [], next_page_offset: null }));

    await served.store.deletePointsByPaths("col", []);
    await unserved.store.deletePointsByPaths("col", []);

    expect(served.client.delete).not.toHaveBeenCalled();
    expect(unserved.client.delete).not.toHaveBeenCalled();
  });
});
