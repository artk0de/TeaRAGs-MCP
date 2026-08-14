/**
 * `finalizeSignals` file-overlay read-back concurrency (bd tea-rags-mcp-6aytq).
 *
 * The read-back used to issue THREE fully serialized DuckDB round-trips per
 * file — getFanIn, getFanOut, and the depth-5 recursive-CTE getTransitiveImpact
 * — over every file the run extracted. On taxdome (10,476 TS files) that is
 * 31,428 sequential daemon IPC calls sitting in the post-pass-2 tail, and the
 * tail measured ~46s.
 *
 * The three reads for one file are independent of each other and of every other
 * file's, so they overlap. What must NOT change: the overlay values, and the
 * insertion order of the returned map (deterministic output regardless of which
 * read wins the race).
 */

import { describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/** Fan values per file, plus a concurrency probe over every read it serves. */
function makeFanGraphDb(fan: Map<string, { fanIn: number; fanOut: number; impact: number }>): {
  graphDb: Record<string, unknown>;
  peakConcurrency: () => number;
  totalReads: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  const read = async <T>(value: T): Promise<T> => {
    inFlight += 1;
    total += 1;
    peak = Math.max(peak, inFlight);
    // One macrotask hop per read — stands in for the daemon round-trip, and
    // gives a serialized implementation no way to look concurrent.
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return value;
  };
  return {
    graphDb: {
      getFanInP95: async () => read(2),
      getFanIn: async (relPath: string) => read(fan.get(relPath)?.fanIn ?? 0),
      getFanOut: async (relPath: string) => read(fan.get(relPath)?.fanOut ?? 0),
      getTransitiveImpact: async (relPath: string) => read(fan.get(relPath)?.impact ?? 0),
      recordRunStats: async () => undefined,
    },
    peakConcurrency: () => peak,
    totalReads: () => total,
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
  it("overlaps the per-file graph reads instead of serializing every round-trip", async () => {
    const paths = Array.from({ length: 24 }, (_, i) => `src/f${i}.ts`);
    const fan = new Map(paths.map((p, i) => [p, { fanIn: i, fanOut: i * 2, impact: i * 3 }]));
    const { graphDb, peakConcurrency } = makeFanGraphDb(fan);

    await makeProvider(graphDb).finalizeSignals("/repo", { paths });

    // Serialized read-back peaks at 1. Anything above proves the overlap.
    expect(peakConcurrency()).toBeGreaterThan(1);
  });

  it("bounds the overlap rather than firing every file's reads at once", async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const { graphDb, peakConcurrency } = makeFanGraphDb(new Map());

    await makeProvider(graphDb).finalizeSignals("/repo", { paths });

    // 200 files × 3 reads = 600 possible in flight. The bound keeps the daemon
    // (and the recursive-CTE memory) from being handed the whole repo at once.
    expect(peakConcurrency()).toBeLessThanOrEqual(64);
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
