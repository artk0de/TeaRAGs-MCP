/**
 * Phase 1 of `QdrantPointStore#deletePointsByPathsBatched`: the ids of every
 * point whose `relativePath` is one of the deleted paths. One exact text+value
 * pair per scroll request, bounded concurrency (bd tea-rags-mcp-b4drg) — on a
 * text-indexed key a wide `should` costs ~6 ms per branch, one pair per request
 * ~1.5 ms. The Qdrant REST client is the only fake.
 */

import { describe, expect, it, vi } from "vitest";

import { QdrantConnection } from "../../../../src/core/adapters/qdrant/connection.js";
import { QdrantPointStore } from "../../../../src/core/adapters/qdrant/point-store.js";

type PairFilter = { must: { key: string; match: { text?: string; value?: string } }[] };
type ScrollArgs = { filter: PairFilter; offset?: unknown };

const pathOf = (filter: PairFilter): string | undefined =>
  filter.must.find((c) => c.match.value !== undefined)?.match.value;

function storeScrolling(scroll: (args: ScrollArgs) => Promise<unknown>) {
  const connection = new QdrantConnection("http://127.0.0.1:6333");
  const client = {
    scroll: vi.fn(async (_collection: string, args: ScrollArgs) => scroll(args)),
    delete: vi.fn(async () => ({})),
  };
  connection.client = client as never;
  return { store: new QdrantPointStore(connection), client };
}

const run = async (store: QdrantPointStore, paths: string[]) =>
  store.deletePointsByPathsBatched("col", paths, { batchSize: 10_000, concurrency: 1 });

const deletedIds = (client: { delete: { mock: { calls: unknown[][] } } }): string[] =>
  client.delete.mock.calls.flatMap((call) => (call[1] as { points: string[] }).points);

describe("QdrantPointStore#deletePointsByPathsBatched id collection", () => {
  it("sends one scroll per path, each filter carrying exactly that path's text+value pair", async () => {
    const { store, client } = storeScrolling(async () => ({ points: [], next_page_offset: null }));
    const paths = Array.from({ length: 450 }, (_, i) => `src/file${i}.ts`);

    await run(store, paths);

    expect(client.scroll).toHaveBeenCalledTimes(450);
    const filters = client.scroll.mock.calls.map((call) => call[1].filter);
    for (const filter of filters) {
      expect(Object.keys(filter)).toEqual(["must"]);
      const path = pathOf(filter);
      expect(filter.must).toEqual([
        { key: "relativePath", match: { text: path } },
        { key: "relativePath", match: { value: path } },
      ]);
    }
    expect(filters.map(pathOf).sort()).toEqual([...paths].sort());
  });

  it("never runs more than 4 scrolls at once, and does reach 4", async () => {
    let active = 0;
    let peak = 0;
    const { store } = storeScrolling(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { points: [], next_page_offset: null };
    });

    await run(
      store,
      Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
    );

    expect(peak).toBe(4);
  });

  it("follows pagination to exhaustion per path and returns the union of ids", async () => {
    const { store, client } = storeScrolling(async (args) => {
      const path = pathOf(args.filter);
      if (path === "big.ts") {
        return args.offset === undefined
          ? { points: [{ id: "b1" }, { id: "b2" }], next_page_offset: "o1" }
          : { points: [{ id: "b3" }], next_page_offset: null };
      }
      return { points: [{ id: `id:${path}` }], next_page_offset: null };
    });

    await run(store, ["a.ts", "big.ts", "c.ts"]);

    expect(client.scroll).toHaveBeenCalledTimes(4);
    expect(deletedIds(client).sort()).toEqual(["b1", "b2", "b3", "id:a.ts", "id:c.ts"]);
  });

  it("scrolls a path listed twice once, so its points are not collected twice", async () => {
    const { store, client } = storeScrolling(async () => ({ points: [{ id: "x" }], next_page_offset: null }));

    await run(store, ["a.ts", "a.ts"]);

    expect(client.scroll).toHaveBeenCalledTimes(1);
    expect(deletedIds(client)).toEqual(["x"]);
  });

  it("propagates a failed scroll", async () => {
    const { store } = storeScrolling(async () => {
      throw new Error("boom");
    });

    await expect(run(store, ["a.ts", "b.ts"])).rejects.toThrow();
  });
});
