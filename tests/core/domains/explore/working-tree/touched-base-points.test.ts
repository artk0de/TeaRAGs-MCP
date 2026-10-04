/**
 * `WorkingTreeTouchedBasePoints` (bd tea-rags-mcp-xi2r9): the ONE reader of
 * the base points of the files a working tree touched. Its cost must follow
 * the ANSWER, not the delta (live probe: 3,198 touched files, a warm
 * find_symbol at ~10 s, all of it re-reading every touched path's git /
 * codegraph payload on every set change and every minute):
 *
 * - per path: a request reads only the paths no earlier request read at this
 *   index revision, so a touched set that grows by one file scrolls one file;
 * - two tiers: LIGHT (identity + span) for whatever needs ids or spans, FULL
 *   (+ git, codegraph) only for the paths a consumer asks heavy for;
 * - the revision is (collection, the index run's stamp, point count) — no
 *   clock expires a light read;
 * - the light tier outlives the process through a store, so a one-shot
 *   `tea-rags call` over a warm cache scrolls nothing it already read.
 *
 * One scroll per path, never a filter naming several: on the live
 * `code_665c0e4c` (137 touched paths, 1972 points) one multi-path scroll took
 * 4482 ms, per-path scrolls in parallel 448 ms.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { createWorkingTreeBasePointStore } from "../../../../../src/core/domains/explore/working-tree/base-point-store.js";
import {
  WORKING_TREE_HEAVY_BASE_POINT_TTL_MS,
  WorkingTreeTouchedBasePoints,
  type WorkingTreeTouchedBasePointsRequest,
} from "../../../../../src/core/domains/explore/working-tree/touched-base-points.js";

const BASE = [
  {
    id: "a1",
    payload: {
      relativePath: "src/a.ts",
      symbolId: "A#one",
      startLine: 1,
      endLine: 3,
      git: { file: { commitCount: 4 } },
      codegraph: { symbols: { file: { fanIn: 2 } } },
    },
  },
  { id: "a2", payload: { relativePath: "src/a.ts", symbolId: "A#two", startLine: 5, endLine: 9 } },
  { id: "b1", payload: { relativePath: "src/b.ts", symbolId: "b", startLine: 1, endLine: 2 } },
  { id: "c1", payload: { relativePath: "src/c.ts", symbolId: "c", startLine: 1, endLine: 2 } },
];

/** A Qdrant that answers each scroll with the rows its filter admits, keeping only the payload asked for. */
const qdrantHolding = (pointsCount = BASE.length) => ({
  getCollectionInfo: vi.fn(async () => ({ pointsCount })),
  scrollFiltered: vi.fn(
    async (
      _collection: string,
      filter: Record<string, unknown>,
      _limit: number,
      _page?: number,
      include?: string[],
    ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> =>
      BASE.filter((point) => payloadMatchesFilter(point.payload, filter)).map((point) => ({
        id: point.id,
        payload: Object.fromEntries(
          Object.entries(point.payload).filter(([key]) => include === undefined || include.includes(key)),
        ),
      })),
  ),
});

type Qdrant = ReturnType<typeof qdrantHolding>;

/** The relativePath values one scroll's filter names. */
const pathsNamedBy = (filter: unknown): string[] =>
  [...JSON.stringify(filter).matchAll(/"value":"([^"]+)"/g)].map((match) => match[1]);

/** The paths every scroll so far named, one per scroll, sorted. */
const scrolledPaths = (qdrant: Qdrant): string[] =>
  qdrant.scrollFiltered.mock.calls.flatMap(([, filter]) => pathsNamedBy(filter)).sort();

const request = (
  paths: string[],
  tier: WorkingTreeTouchedBasePointsRequest["tier"] = "light",
  indexStamp: string | null = "2026-10-03T10:00:00.000Z",
): WorkingTreeTouchedBasePointsRequest => ({ collectionName: "c", indexStamp, paths: new Set(paths), tier });

const HEAVY_KEYS = ["git", "codegraph"];

describe("WorkingTreeTouchedBasePoints", () => {
  it("should read the base points of exactly the asked paths, grouped by path in path order", async () => {
    const reader = new WorkingTreeTouchedBasePoints(qdrantHolding());

    const points = await reader.pointsOf(request(["src/b.ts", "src/a.ts", "src/new.ts"]));

    expect([...points.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(points.get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(points.get("src/b.ts")?.map((p) => p.id)).toEqual(["b1"]);
  });

  it("should scroll once per path and never send a filter naming several paths", async () => {
    const qdrant = qdrantHolding();

    await new WorkingTreeTouchedBasePoints(qdrant).pointsOf(request(["src/a.ts", "src/b.ts", "src/c.ts"]));

    const named = qdrant.scrollFiltered.mock.calls.map(([, filter]) => pathsNamedBy(filter));
    expect(named.every((paths) => new Set(paths).size === 1)).toBe(true);
    expect(scrolledPaths(qdrant)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("should never ask Qdrant for git or codegraph payload on a light read", async () => {
    const qdrant = qdrantHolding();

    const points = await new WorkingTreeTouchedBasePoints(qdrant).pointsOf(request(["src/a.ts", "src/b.ts"]));

    for (const [, , , , include] of qdrant.scrollFiltered.mock.calls) {
      expect(include).toBeDefined();
      expect(include?.filter((key) => HEAVY_KEYS.includes(key))).toEqual([]);
      expect([...(include ?? [])].sort()).toEqual(["endLine", "relativePath", "startLine", "symbolId"]);
    }
    expect(points.get("src/a.ts")?.[0].payload).toEqual({
      relativePath: "src/a.ts",
      symbolId: "A#one",
      startLine: 1,
      endLine: 3,
    });
  });

  it("should scroll the heavy payload of exactly the paths a full read names", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    await reader.pointsOf(request(["src/a.ts", "src/b.ts", "src/c.ts"]));
    qdrant.scrollFiltered.mockClear();

    const points = await reader.pointsOf(request(["src/a.ts"], "full"));

    expect(scrolledPaths(qdrant)).toEqual(["src/a.ts"]);
    expect(qdrant.scrollFiltered.mock.calls[0][4]).toEqual(expect.arrayContaining(HEAVY_KEYS));
    expect(points.get("src/a.ts")?.[0].payload.git).toEqual({ file: { commitCount: 4 } });
    expect(points.get("src/a.ts")?.[0].payload.codegraph).toEqual({ symbols: { file: { fanIn: 2 } } });
    expect([...points.keys()]).toEqual(["src/a.ts"]);
  });

  it("should serve a later light read of a path a full read already scrolled without a scroll", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    await reader.pointsOf(request(["src/a.ts"], "full"));
    qdrant.scrollFiltered.mockClear();

    const points = await reader.pointsOf(request(["src/a.ts"]));

    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
    expect(points.get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
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

    await new WorkingTreeTouchedBasePoints(qdrant).pointsOf(
      request(Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`)),
    );

    expect(qdrant.scrollFiltered).toHaveBeenCalledTimes(40);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
  });

  // Live probe: a pending file turning warm grew the touched set by one path
  // and re-read all 3,198.
  it("should scroll only the new path when the touched set grows by one", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    await reader.pointsOf(request(["src/a.ts", "src/b.ts"]));
    qdrant.scrollFiltered.mockClear();

    const grown = await reader.pointsOf(request(["src/a.ts", "src/b.ts", "src/c.ts"]));

    expect(scrolledPaths(qdrant)).toEqual(["src/c.ts"]);
    expect([...grown.keys()]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("should remember a path the index holds no points for, so it is not scrolled again", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    await reader.pointsOf(request(["src/new.ts"]));
    qdrant.scrollFiltered.mockClear();

    expect((await reader.pointsOf(request(["src/new.ts"]))).size).toBe(0);
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
  });

  it("should share one scroll per path between concurrent requests", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);

    const [first, second] = await Promise.all([
      reader.pointsOf(request(["src/a.ts", "src/b.ts"])),
      reader.pointsOf(request(["src/b.ts", "src/c.ts"])),
    ]);

    expect(scrolledPaths(qdrant)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(first.get("src/b.ts")).toEqual(second.get("src/b.ts"));
  });

  it("should not expire a light read by the clock", async () => {
    const qdrant = qdrantHolding();
    let clock = 0;
    const reader = new WorkingTreeTouchedBasePoints(qdrant, { now: () => clock });
    await reader.pointsOf(request(["src/a.ts"]));
    qdrant.scrollFiltered.mockClear();
    clock += 24 * 3_600_000;

    await reader.pointsOf(request(["src/a.ts"]));

    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
  });

  // The heavy blocks are written by enrichment, which may finish after the
  // run stamped the registry and without moving the point count.
  it("should re-read a path's heavy payload once its safety window passed, and not before", async () => {
    const qdrant = qdrantHolding();
    let clock = 0;
    const reader = new WorkingTreeTouchedBasePoints(qdrant, { now: () => clock });
    await reader.pointsOf(request(["src/a.ts"], "full"));
    clock += WORKING_TREE_HEAVY_BASE_POINT_TTL_MS - 1;
    await reader.pointsOf(request(["src/a.ts"], "full"));
    const withinWindow = qdrant.scrollFiltered.mock.calls.length;
    clock += 1;

    await reader.pointsOf(request(["src/a.ts"], "full"));

    expect(withinWindow).toBe(1);
    expect(qdrant.scrollFiltered).toHaveBeenCalledTimes(2);
  });

  it("should read again when the index stamp or the point count moves", async () => {
    const qdrant = qdrantHolding();
    const reader = new WorkingTreeTouchedBasePoints(qdrant);
    const scrolls = () => qdrant.scrollFiltered.mock.calls.length;

    await reader.pointsOf(request(["src/a.ts"], "light", "run-1"));
    const afterFirst = scrolls();
    await reader.pointsOf(request(["src/a.ts"], "light", "run-2"));
    const afterStamp = scrolls();
    qdrant.getCollectionInfo.mockResolvedValue({ pointsCount: BASE.length + 1 });
    await reader.pointsOf(request(["src/a.ts"], "light", "run-2"));

    expect(afterStamp).toBeGreaterThan(afterFirst);
    expect(scrolls()).toBeGreaterThan(afterStamp);
  });

  it("should answer an empty path set without a query", async () => {
    const qdrant = qdrantHolding();

    expect((await new WorkingTreeTouchedBasePoints(qdrant).pointsOf(request([]))).size).toBe(0);
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
    expect(qdrant.getCollectionInfo).not.toHaveBeenCalled();
  });

  it("should not keep a failed read, so the next request retries", async () => {
    const qdrant = qdrantHolding();
    qdrant.scrollFiltered.mockRejectedValueOnce(new Error("qdrant down"));
    const reader = new WorkingTreeTouchedBasePoints(qdrant);

    await expect(reader.pointsOf(request(["src/a.ts"]))).rejects.toThrow("qdrant down");
    expect((await reader.pointsOf(request(["src/a.ts"]))).get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  describe("across processes", () => {
    let rootDir: string;
    const store = () => createWorkingTreeBasePointStore({ rootDir });

    beforeEach(() => {
      rootDir = mkdtempSync(join(tmpdir(), "wt-base-points-"));
    });

    afterEach(() => {
      rmSync(rootDir, { recursive: true, force: true });
    });

    it("should answer a light read another instance made at the same revision with zero scrolls", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(
        request(["src/a.ts", "src/b.ts", "src/new.ts"]),
      );
      const qdrant = qdrantHolding();

      const points = await new WorkingTreeTouchedBasePoints(qdrant, { store: store() }).pointsOf(
        request(["src/a.ts", "src/b.ts", "src/new.ts"]),
      );

      expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
      expect([...points.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
      expect(points.get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
    });

    it("should scroll only the paths the stored revision lacks", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(request(["src/a.ts"]));
      const qdrant = qdrantHolding();

      await new WorkingTreeTouchedBasePoints(qdrant, { store: store() }).pointsOf(request(["src/a.ts", "src/b.ts"]));

      expect(scrolledPaths(qdrant)).toEqual(["src/b.ts"]);
    });

    it("should not serve a stored read of another index stamp or point count", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(
        request(["src/a.ts"], "light", "run-1"),
      );
      const restamped = qdrantHolding();
      const recounted = qdrantHolding(BASE.length + 1);

      await new WorkingTreeTouchedBasePoints(restamped, { store: store() }).pointsOf(
        request(["src/a.ts"], "light", "run-2"),
      );
      await new WorkingTreeTouchedBasePoints(recounted, { store: store() }).pointsOf(
        request(["src/a.ts"], "light", "run-1"),
      );

      expect(scrolledPaths(restamped)).toEqual(["src/a.ts"]);
      expect(scrolledPaths(recounted)).toEqual(["src/a.ts"]);
    });

    it("should never persist the heavy payload", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(
        request(["src/a.ts"], "full"),
      );
      const qdrant = qdrantHolding();
      const reader = new WorkingTreeTouchedBasePoints(qdrant, { store: store() });

      const light = await reader.pointsOf(request(["src/a.ts"]));
      const full = await reader.pointsOf(request(["src/a.ts"], "full"));

      expect(light.get("src/a.ts")?.[0].payload).not.toHaveProperty("git");
      expect(scrolledPaths(qdrant)).toEqual(["src/a.ts"]);
      expect(full.get("src/a.ts")?.[0].payload.git).toEqual({ file: { commitCount: 4 } });
    });

    it("should fall back to scrolling, never throw, when the stored file is corrupt or gone", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(request(["src/a.ts"]));
      const dir = join(rootDir, ".base-points");
      for (const name of readdirSync(dir)) writeFileSync(join(dir, name), "{not json");
      const corrupt = qdrantHolding();
      const points = await new WorkingTreeTouchedBasePoints(corrupt, { store: store() }).pointsOf(
        request(["src/a.ts"]),
      );
      rmSync(dir, { recursive: true, force: true });
      const gone = qdrantHolding();
      await new WorkingTreeTouchedBasePoints(gone, { store: store() }).pointsOf(request(["src/a.ts"]));

      expect(points.get("src/a.ts")?.map((p) => p.id)).toEqual(["a1", "a2"]);
      expect(scrolledPaths(corrupt)).toEqual(["src/a.ts"]);
      expect(scrolledPaths(gone)).toEqual(["src/a.ts"]);
    });

    it("should persist nothing for a read with no index stamp", async () => {
      await new WorkingTreeTouchedBasePoints(qdrantHolding(), { store: store() }).pointsOf(
        request(["src/a.ts"], "light", null),
      );
      const qdrant = qdrantHolding();

      await new WorkingTreeTouchedBasePoints(qdrant, { store: store() }).pointsOf(request(["src/a.ts"], "light", null));

      expect(scrolledPaths(qdrant)).toEqual(["src/a.ts"]);
    });
  });
});
