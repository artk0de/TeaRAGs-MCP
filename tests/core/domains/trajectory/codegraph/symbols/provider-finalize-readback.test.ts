/**
 * `finalizeSignals` file-overlay read-back (bd tea-rags-mcp-6aytq).
 *
 * The read-back used to issue THREE DuckDB round-trips per file — getFanIn,
 * getFanOut, and the depth-5 recursive-CTE getTransitiveImpact — over every
 * file the run extracted. On taxdome (10,476 TS files) that is 31,428 daemon
 * calls sitting in the post-pass-2 tail. Overlapping them 16-wide did not fix
 * it: the daemon is a single process, so the concurrency only moved the queue,
 * and the interleaved reads starved the pass-2 bulk flush running alongside.
 *
 * The tail now reads the whole set through `getFileMetricsBulk` — a constant
 * number of statements per batch, whatever the file count. What must NOT
 * change: the overlay values, and the insertion order of the returned map.
 */

import { describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * Fan values per file, served through the bulk read the finalize tail uses.
 * Per-file getters are still present — and counted — because a silent fallback
 * to them is exactly the regression this suite exists to catch.
 */
function makeFanGraphDb(fan: Map<string, { fanIn: number; fanOut: number; impact: number }>): {
  graphDb: Record<string, unknown>;
  bulkRequests: () => string[][];
  perFileReads: () => number;
} {
  const requests: string[][] = [];
  let perFile = 0;
  const perFileRead = async <T>(value: T): Promise<T> => {
    perFile += 1;
    return value;
  };
  return {
    graphDb: {
      getFanInP95: async () => 2,
      getFileMetricsBulk: async (relPaths: string[]) => {
        requests.push([...relPaths]);
        // One macrotask hop per request — stands in for the daemon round-trip.
        await new Promise((r) => setTimeout(r, 1));
        const out = new Map<string, { fanIn: number; fanOut: number; transitiveImpact: number }>();
        for (const relPath of relPaths) {
          const f = fan.get(relPath);
          if (f) out.set(relPath, { fanIn: f.fanIn, fanOut: f.fanOut, transitiveImpact: f.impact });
        }
        return out;
      },
      getFanIn: async (relPath: string) => perFileRead(fan.get(relPath)?.fanIn ?? 0),
      getFanOut: async (relPath: string) => perFileRead(fan.get(relPath)?.fanOut ?? 0),
      getTransitiveImpact: async (relPath: string) => perFileRead(fan.get(relPath)?.impact ?? 0),
      recordRunStats: async () => undefined,
    },
    bulkRequests: () => requests,
    perFileReads: () => perFile,
  };
}

function makeProvider(graphDb: Record<string, unknown>): CodegraphEnrichmentProvider {
  return new CodegraphEnrichmentProvider({
    graphDb: graphDb as never,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
}

describe("CodegraphEnrichmentProvider finalize read-back (bd tea-rags-mcp-6aytq)", () => {
  it("reads the whole file set in a constant number of round-trips, not three per file", async () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `src/f${i}.ts`);
    const fan = new Map(paths.map((p, i) => [p, { fanIn: i, fanOut: i * 2, impact: i * 3 }]));
    const { graphDb, bulkRequests, perFileReads } = makeFanGraphDb(fan);

    await makeProvider(graphDb).finalizeSignals("/repo", { paths });

    // 1000 files cost a handful of requests, not 3000 — and not one per file
    // however finely they are batched.
    expect(bulkRequests().length).toBeLessThanOrEqual(8);
    // No per-file round-trip survives in the tail.
    expect(perFileReads()).toBe(0);
    // Every requested path is covered exactly once across the requests.
    expect(bulkRequests().flat()).toEqual(paths);
  });

  it("splits a large path set into bounded batches rather than one unbounded request", async () => {
    const paths = Array.from({ length: 20_000 }, (_, i) => `src/f${i}.ts`);
    const { graphDb, bulkRequests } = makeFanGraphDb(new Map());

    await makeProvider(graphDb).finalizeSignals("/repo", { paths });

    // Handing 20k paths to the daemon in one frame is both a message-size and a
    // recursive-CTE memory hazard, so the set is chunked.
    expect(bulkRequests().length).toBeGreaterThan(1);
    for (const batch of bulkRequests()) expect(batch.length).toBeLessThanOrEqual(4096);
  });

  it("returns the same overlay values, in input path order, regardless of read interleaving", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const fan = new Map([
      ["src/a.ts", { fanIn: 7, fanOut: 3, impact: 11 }],
      ["src/b.ts", { fanIn: 0, fanOut: 0, impact: 0 }],
      ["src/c.ts", { fanIn: 4, fanOut: 0, impact: 2 }],
    ]);
    const { graphDb } = makeFanGraphDb(fan);

    const overlays = await makeProvider(graphDb).finalizeSignals("/repo", { paths });

    expect([...overlays.keys()]).toEqual(paths);
    expect(overlays.get("src/a.ts")).toEqual({
      fanIn: 7,
      fanOut: 3,
      instability: 3 / 10,
      connectionCount: 10,
      isHub: true, // p95 stub = 2
      isLeaf: false,
      transitiveImpact: 11,
    });
    // Zero on both sides: instability degenerates to 0, and isLeaf needs fanIn.
    expect(overlays.get("src/b.ts")).toEqual({
      fanIn: 0,
      fanOut: 0,
      instability: 0,
      connectionCount: 0,
      isHub: false,
      isLeaf: false,
      transitiveImpact: 0,
    });
    expect(overlays.get("src/c.ts")).toMatchObject({ isLeaf: true, isHub: true, instability: 0 });
  });

  it("reads the collection-wide fanIn p95 once for the whole pass, not once per file", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    let p95Reads = 0;
    const { graphDb } = makeFanGraphDb(new Map());
    const counting = {
      ...graphDb,
      getFanInP95: async () => {
        p95Reads += 1;
        return 2;
      },
    };

    await makeProvider(counting).finalizeSignals("/repo", { paths });

    expect(p95Reads).toBe(1);
  });
});
