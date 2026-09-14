/**
 * createCodegraphPayloadHealRunner — the composition of the codegraph payload
 * heal (bd tea-rags-mcp-wd6kv).
 *
 * The healer itself is covered; the wiring around it was not, and it carries
 * the three decisions that make the heal safe to re-run:
 *
 *  - an empty diff costs nothing. The scroll is the expensive part of the pass
 *    (one unfiltered traversal of the whole collection), and the baseline
 *    refresh is a write on the shared daemon.
 *  - the baseline advances only AFTER the rewrite landed. Refreshing first
 *    erases the diff, and a heal that then threw would leave the drift
 *    invisible until each affected file happened to change again.
 *  - the two signal builders are bulk reads taken once per run. Per item they
 *    would be one `getFileMetricsBulk` + one `getFanInP95` per file and a point
 *    read per symbol — tens of thousands of daemon round-trips on a first heal,
 *    which names every file there is.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createCodegraphPayloadHealRunner,
  type CodegraphPayloadHealRunnerDeps,
} from "../../../../../src/core/api/internal/infra/codegraph-payload-heal-runner.js";
import type { CodegraphSignalDrift } from "../../../../../src/core/contracts/types/codegraph-storage.js";
import type { GraphDbClient } from "../../../../../src/core/contracts/types/codegraph.js";
import type { BatchPayloadOp } from "../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";

const PROVIDER_KEY = "codegraph.symbols";
const COLLECTION = "code_test";

interface StoredPoint {
  id: string;
  relativePath: string;
  symbolId: string;
}

/**
 * The collection as the streaming pass reads it: pages of projected payload.
 * `pageSize` is the stub's own, so a test can put a page boundary in the middle
 * of a file — the only way to falsify "the builders are memoised", since a file
 * spanning two pages is what makes `flush` ask for its signals twice.
 *
 * Deliberately a plain class with no `implements`: an extra method on the real
 * port must not turn this file red. The two the healer needs to CHOOSE a read
 * shape are answered so that it always takes the streaming pass — the shape
 * this spec exercises: the collection is a handful of points, and per-file
 * scrolls win only when `targetFiles * 2 < points * 0.018`, which a handful can
 * never satisfy.
 */
class PagedQdrantStub {
  scrollCalls = 0;
  readonly writes: BatchPayloadOp[][] = [];
  /** Every batchSetPayload rejects, exhausting the healer's retry budget. */
  writeAlwaysFails = false;
  /** Appended to by both sides, so ordering between them is assertable. */
  readonly timeline: string[] = [];

  constructor(
    private readonly points: readonly StoredPoint[],
    private readonly pageSize = 1000,
  ) {}

  /** The collection's size, as the mode decision reads it. */
  async countPoints(_collectionName: string): Promise<number> {
    return this.points.length;
  }

  /** The per-file shape is not what this spec exercises; reaching it is a defect. */
  async scrollFiltered(): Promise<never> {
    throw new Error("PagedQdrantStub: per-file scroll requested; this spec expects the streaming pass");
  }

  async *scrollPayloadPages(
    _collectionName: string,
    _payloadInclude: string[],
    _pageSize?: number,
  ): AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]> {
    this.scrollCalls++;
    for (let start = 0; start < this.points.length; start += this.pageSize) {
      yield this.points
        .slice(start, start + this.pageSize)
        .map(({ id, relativePath, symbolId }) => ({ id, payload: { relativePath, symbolId } }));
    }
  }

  async batchSetPayload(_collectionName: string, operations: BatchPayloadOp[]): Promise<void> {
    if (this.writeAlwaysFails) throw new Error("qdrant unavailable");
    this.timeline.push("write");
    this.writes.push(operations);
  }

  /** Every point id that took at least one write. */
  get writtenIds(): Set<string | number> {
    return new Set(this.writes.flat().flatMap((op) => op.points));
  }
}

/** The five graph reads the runner makes, each a spy so call counts are assertable. */
function graphDbStub(drift: CodegraphSignalDrift, timeline: string[]) {
  return {
    diffSymbolSignals: vi.fn().mockResolvedValue(drift),
    refreshSymbolSignalsPrev: vi.fn().mockImplementation(async () => {
      timeline.push("refresh");
    }),
    getFanInP95: vi.fn().mockResolvedValue(1),
    getFileMetricsBulk: vi.fn(async (relPaths: readonly string[]) =>
      Promise.resolve(new Map(relPaths.map((relPath) => [relPath, { fanIn: 3, fanOut: 1, transitiveImpact: 7 }]))),
    ),
    getChunkSignalsBulk: vi.fn().mockResolvedValue(new Map([["a.ts::alpha", { fanIn: 2, fanOut: 0, pageRank: 0.25 }]])),
    // No persisted ranges: every point keeps its own payload symbolId as owner
    // (bd tea-rags-mcp-9i2ow), which is what these fixtures are written against.
    getSymbolLineRangesBulk: vi.fn().mockResolvedValue(new Map()),
  };
}

function makeRunner(qdrant: PagedQdrantStub, graphDb: ReturnType<typeof graphDbStub>) {
  const deps: CodegraphPayloadHealRunnerDeps = {
    // Structurally compatible on everything the healer calls; cast so a future
    // member on the port (see PagedQdrantStub) does not break the fake.
    qdrant: qdrant as unknown as CodegraphPayloadHealRunnerDeps["qdrant"],
    acquireGraphDb: vi.fn(async () => Promise.resolve(graphDb as unknown as GraphDbClient)),
    providerKey: PROVIDER_KEY,
  };
  return createCodegraphPayloadHealRunner(deps);
}

/** Two files interleaved across pages, plus one point nothing in the diff names. */
const POINTS: StoredPoint[] = [
  { id: "1", relativePath: "a.ts", symbolId: "a.ts::alpha" },
  { id: "2", relativePath: "b.ts", symbolId: "b.ts::gamma" },
  { id: "3", relativePath: "a.ts", symbolId: "a.ts::beta" },
  { id: "4", relativePath: "b.ts", symbolId: "b.ts::delta" },
  { id: "5", relativePath: "c.ts", symbolId: "c.ts::eps" },
  { id: "6", relativePath: "z.ts", symbolId: "z.ts::omega" },
];

const DRIFT: CodegraphSignalDrift = {
  symbols: [
    { relPath: "a.ts", symbolId: "a.ts::alpha" },
    { relPath: "a.ts", symbolId: "a.ts::beta" },
    { relPath: "b.ts", symbolId: "b.ts::gamma" },
    { relPath: "c.ts", symbolId: "c.ts::eps" },
  ],
  files: [{ relPath: "a.ts" }, { relPath: "b.ts" }, { relPath: "c.ts" }],
};

const EMPTY_DRIFT: CodegraphSignalDrift = { symbols: [], files: [] };

describe("createCodegraphPayloadHealRunner (bd tea-rags-mcp-wd6kv)", () => {
  it("does nothing at all when the graph matches the baseline", async () => {
    const qdrant = new PagedQdrantStub(POINTS);
    const graphDb = graphDbStub(EMPTY_DRIFT, qdrant.timeline);

    const outcome = await makeRunner(qdrant, graphDb).run(COLLECTION, new Set());

    expect(outcome).toEqual({ pointsRewritten: 0, filesTouched: 0 });
    // The scroll is the whole cost of the pass, and the refresh is a write on
    // the shared daemon. Neither is worth paying for a diff of nothing.
    expect(qdrant.scrollCalls).toBe(0);
    expect(qdrant.writes).toEqual([]);
    expect(graphDb.refreshSymbolSignalsPrev).not.toHaveBeenCalled();
  });

  it("rewrites what moved, then advances the baseline", async () => {
    const qdrant = new PagedQdrantStub(POINTS, 2);
    const graphDb = graphDbStub(DRIFT, qdrant.timeline);

    const outcome = await makeRunner(qdrant, graphDb).run(COLLECTION, new Set(), "2026-09-12T00:00:00Z");

    expect(outcome).toEqual({ pointsRewritten: 5, filesTouched: 3 });
    // Point 6 belongs to a file the diff never names.
    expect(qdrant.writtenIds).toEqual(new Set(["1", "2", "3", "4", "5"]));
    // The ordering is the invariant: refreshing before the rewrite lands erases
    // the diff a failed heal would have to retry.
    expect(qdrant.timeline.at(-1)).toBe("refresh");
    expect(graphDb.refreshSymbolSignalsPrev).toHaveBeenCalledTimes(1);
  });

  it("leaves the baseline standing when the rewrite fails", async () => {
    const qdrant = new PagedQdrantStub(POINTS, 2);
    qdrant.writeAlwaysFails = true;
    const graphDb = graphDbStub(DRIFT, qdrant.timeline);

    await expect(makeRunner(qdrant, graphDb).run(COLLECTION, new Set())).rejects.toThrow(/heal/);

    // The drift stays visible to the next run, which is the whole point of
    // refreshing last.
    expect(graphDb.refreshSymbolSignalsPrev).not.toHaveBeenCalled();
  });

  it("loads each bulk read once per run, however many files and symbols it heals", async () => {
    // Page size 2 puts a.ts and b.ts on two pages each, so `flush` asks for
    // their file signals twice — a per-item read would show up as a second
    // getFileMetricsBulk, and a per-symbol read as four getChunkSignalsBulk.
    const qdrant = new PagedQdrantStub(POINTS, 2);
    const graphDb = graphDbStub(DRIFT, qdrant.timeline);

    await makeRunner(qdrant, graphDb).run(COLLECTION, new Set());

    expect(graphDb.getFanInP95).toHaveBeenCalledTimes(1);
    expect(graphDb.getFileMetricsBulk).toHaveBeenCalledTimes(1);
    expect(graphDb.getChunkSignalsBulk).toHaveBeenCalledTimes(1);
    // The p95 is read over the FULL file universe, but the metrics read is
    // scoped to the diff's own paths.
    expect(graphDb.getFileMetricsBulk).toHaveBeenCalledWith(["a.ts", "b.ts", "c.ts"]);
  });
});
