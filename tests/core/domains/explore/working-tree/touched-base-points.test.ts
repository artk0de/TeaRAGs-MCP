/**
 * `WorkingTreeTouchedBasePoints` (bd tea-rags-mcp-xi2r9): the ONE reader of
 * the base points of the files a working tree touched. Two consumers read it
 * per request — hybrid_search's `has_id` exclusion (ids) and the delta-signal
 * source (git / codegraph payload to inherit) — so it must be cheap on every
 * request after the first and must never send the many-path filter: on the
 * live `code_665c0e4c` (137 touched paths, 1972 points) one scroll with a
 * multi-path `relativePath` filter took 4482 ms with payload, per-path scrolls
 * in parallel 448 ms. The text-indexed key serves a single-path condition;
 * a many-branch one degenerates to a scan.
 */
import { describe, expect, it, vi } from "vitest";

import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { WorkingTreeTouchedBasePoints } from "../../../../../src/core/domains/explore/working-tree/touched-base-points.js";

const BASE = [
  { id: "a1", payload: { relativePath: "src/a.ts", symbolId: "A#one", startLine: 1, endLine: 3, git: { file: {} } } },
  { id: "a2", payload: { relativePath: "src/a.ts", symbolId: "A#two", startLine: 5, endLine: 9 } },
  { id: "b1", payload: { relativePath: "src/b.ts", symbolId: "b" } },
  { id: "c1", payload: { relativePath: "src/c.ts", symbolId: "c" } },
];

/** A Qdrant that answers each scroll with the rows its filter admits, as the server does. */
const qdrantHolding = (pointsCount = BASE.length) => ({
  getCollectionInfo: vi.fn(async () => ({ pointsCount })),
  scrollFiltered: vi.fn(async (_collection: string, filter: Record<string, unknown>) =>
    BASE.filter((point) => payloadMatchesFilter(point.payload, filter)),
  ),
});

/** The relativePath values one scroll's filter names. */
const pathsNamedBy = (filter: unknown): string[] =>
  [...JSON.stringify(filter).matchAll(/"value":"([^"]+)"/g)].map((match) => match[1]);

describe("WorkingTreeTouchedBasePoints", () => {
  it("should read the base points of exactly the touched paths, grouped by path in path order", async () => {
    const reader = new WorkingTreeTouchedBasePoints(qdrantHolding());

    const points = await reader.pointsOf("c", new Set(["src/b.ts", "src/a.ts", "src/new.ts"]), "sha");

    expect([...points.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(points.get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(points.get("src/b.ts")?.map((p) => p.id)).toEqual(["b1"]);
  });

  it("should scroll once per path and never send a filter naming several paths", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);

    await reader.pointsOf("c", new Set(["src/a.ts", "src/b.ts", "src/c.ts"]), "sha");

    expect(qdrant.scrollFiltered).toHaveBeenCalledTimes(3);
    const named = qdrant.scrollFiltered.mock.calls.map(([, filter]) => pathsNamedBy(filter));
    expect(named.every((paths) => new Set(paths).size === 1)).toBe(true);
    expect(named.map((paths) => paths[0]).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("should ask for the payload subset both consumers read", async () => {
    const qdrant = qdrantHolding();

    await new WorkingTreeTouchedBasePoints(qdrant).pointsOf("c", new Set(["src/a.ts"]), "sha");

    const payloadInclude = qdrant.scrollFiltered.mock.calls[0][4];
    expect([...(payloadInclude ?? [])].sort()).toEqual(
      ["codegraph", "endLine", "git", "relativePath", "startLine", "symbolId"].sort(),
    );
  });

  it("should keep at most 16 per-path scrolls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const qdrant = {
      getCollectionInfo: vi.fn(async () => ({ pointsCount: 1 })),
      scrollFiltered: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return [];
      }),
    };
    const paths = new Set(Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`));

    await new WorkingTreeTouchedBasePoints(qdrant).pointsOf("c", paths, "sha");

    expect(qdrant.scrollFiltered).toHaveBeenCalledTimes(40);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
  });

  it("should not scroll again for the same collection, touched set and index revision", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);

    await reader.pointsOf("c", new Set(["src/a.ts", "src/b.ts"]), "sha");
    const calls = qdrant.scrollFiltered.mock.calls.length;
    const again = await reader.pointsOf("c", new Set(["src/b.ts", "src/a.ts"]), "sha");

    expect(qdrant.scrollFiltered.mock.calls.length).toBe(calls);
    expect([...again.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("should share one read between concurrent identical requests", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    const touched = new Set(["src/a.ts", "src/b.ts"]);

    const [first, second] = await Promise.all([
      reader.pointsOf("c", touched, "sha"),
      reader.pointsOf("c", touched, "sha"),
    ]);

    expect(qdrant.scrollFiltered).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
  });

  it("should read again when the point count, the indexed commit or the touched set moves, or the entry ages out", async () => {
    const qdrant = qdrantHolding();
    let clock = 0;
    const reader = new WorkingTreeTouchedBasePoints(qdrant, () => clock);
    const scrolls = () => qdrant.scrollFiltered.mock.calls.length;

    await reader.pointsOf("c", new Set(["src/a.ts"]), "sha-1");
    const afterFirst = scrolls();
    qdrant.getCollectionInfo.mockResolvedValue({ pointsCount: BASE.length + 1 });
    await reader.pointsOf("c", new Set(["src/a.ts"]), "sha-1");
    const afterCount = scrolls();
    await reader.pointsOf("c", new Set(["src/a.ts"]), "sha-2");
    const afterCommit = scrolls();
    await reader.pointsOf("c", new Set(["src/a.ts", "src/c.ts"]), "sha-2");
    const afterSet = scrolls();
    clock += 10 * 60_000;
    await reader.pointsOf("c", new Set(["src/a.ts", "src/c.ts"]), "sha-2");

    expect(afterCount).toBeGreaterThan(afterFirst);
    expect(afterCommit).toBeGreaterThan(afterCount);
    expect(afterSet).toBeGreaterThan(afterCommit);
    expect(scrolls()).toBeGreaterThan(afterSet);
  });

  it("should answer an empty touched set without a query", async () => {
    const qdrant = qdrantHolding();

    expect((await new WorkingTreeTouchedBasePoints(qdrant).pointsOf("c", new Set(), "sha")).size).toBe(0);
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
    expect(qdrant.getCollectionInfo).not.toHaveBeenCalled();
  });

  it("should not keep a failed read, so the next request retries", async () => {
    const qdrant = qdrantHolding();
    qdrant.scrollFiltered.mockRejectedValueOnce(new Error("qdrant down"));
    const reader = new WorkingTreeTouchedBasePoints(qdrant);

    await expect(reader.pointsOf("c", new Set(["src/a.ts"]), "sha")).rejects.toThrow("qdrant down");
    expect((await reader.pointsOf("c", new Set(["src/a.ts"]), "sha")).get("src/a.ts")?.map((p) => p.id)).toEqual([
      "a1",
      "a2",
    ]);
  });
});
