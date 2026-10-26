/**
 * Empty graph answers explain themselves (agent turn economy N6, bd
 * tea-rags-mcp-wrosj). An empty `callers` / `callees` list used to conflate a
 * symbol the graph does not hold, an id addressed with the wrong separator, and
 * a real node with no edges. Now:
 *
 * - wrong separator (`Class.method` for an instance method) → the swapped id is
 *   answered and named in `resolvedSymbolId`;
 * - node absent → `empty.reason: "unknownSymbol"` with short-name matches;
 * - node present, zero edges → `empty.reason: "noEdges"`, a "lower bound" note
 *   when the language's resolve rate is under 0.9;
 * - unknown file → `empty.reason: "unknownFile"` beside the legacy `message`.
 *
 * A non-empty answer runs none of the diagnostic reads.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type {
  CalleeEdge,
  CallerEdge,
  ResolveRunStatsRow,
  SymbolVisibilityRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const REAL = "GraphFacade#findCoChanged";

const CALLERS: Record<string, CallerEdge[]> = {
  [REAL]: [{ sourceSymbolId: "App#findCoChanged", sourceRelPath: "src/app.ts", callExpression: "findCoChanged(req)" }],
};
const CALLEES: Record<string, CalleeEdge[]> = {
  [REAL]: [{ targetSymbolId: "CochangeOps#find", targetRelPath: "src/ops.ts", callExpression: "find(db)" }],
};
const SYMBOLS: SymbolVisibilityRow[] = [
  { relPath: "src/graph-facade.ts", symbolId: REAL, visibility: null },
  { relPath: "src/lonely.ts", symbolId: "Lonely#run", visibility: null },
];

function statsRow(language: string, attempted: number, resolved: number): ResolveRunStatsRow {
  return { language, receiverKind: "member", attempted, resolved, externalSkipped: 0, unresolvable: 0 };
}

function graphDb(runStats: ResolveRunStatsRow[] = [statsRow("typescript", 100, 95)]) {
  return {
    getCallers: vi.fn(async (id: string) => CALLERS[id] ?? []),
    getCallees: vi.fn(async (id: string) => CALLEES[id] ?? []),
    getSupertypes: vi.fn(async () => []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => SYMBOLS.filter((r) => ids.includes(r.symbolId))),
    lookupSymbolIdsByShortName: vi.fn(async (shortName: string, limit: number) =>
      ["Alpha#nope", "Beta.nope", "Gamma#nope", "Delta#nope", "Eps#nope", "Zeta#nope"]
        .filter((id) => id.endsWith(shortName))
        .slice(0, limit),
    ),
    getRunStats: vi.fn(async () => runStats),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakePool(db: ReturnType<typeof graphDb>): GraphDbClientPool {
  return {
    acquireReader: vi.fn().mockResolvedValue({ graphDb: db, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
}

const registry = {} as CollectionRegistry;

function facadeOver(db: ReturnType<typeof graphDb>): GraphFacade {
  return new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });
}

describe("GraphFacade — empty answers explain themselves (N6)", () => {
  it("get_callers with the wrong separator answers the swapped id and names it in resolvedSymbolId", async () => {
    const res = await facadeOver(graphDb()).getCallers({ collection: "c", symbolId: "GraphFacade.findCoChanged" });

    expect(res).toMatchObject({ resolvedSymbolId: REAL, callers: CALLERS[REAL] });
    expect("empty" in res).toBe(false);
  });

  it("get_callees with the wrong separator answers the swapped id and names it in resolvedSymbolId", async () => {
    const res = await facadeOver(graphDb()).getCallees({ collection: "c", symbolId: "GraphFacade.findCoChanged" });

    expect(res).toMatchObject({ resolvedSymbolId: REAL, callees: CALLEES[REAL] });
    expect("empty" in res).toBe(false);
  });

  it("an id absent under both separators is unknownSymbol with at most five short-name matches", async () => {
    const db = graphDb();
    const res = await facadeOver(db).getCallers({ collection: "c", symbolId: "NoSuchThing#nope" });

    expect(res).toMatchObject({ callers: [], empty: { reason: "unknownSymbol" } });
    const empty = "empty" in res ? res.empty : undefined;
    expect(empty?.message).toMatch(/NoSuchThing#nope/);
    expect(empty?.suggestions).toEqual(["Alpha#nope", "Beta.nope", "Gamma#nope", "Delta#nope", "Eps#nope"]);
    expect(db.lookupSymbolIdsByShortName).toHaveBeenCalledWith("nope", 5);
  });

  it("a present node with zero edges is noEdges, flagged as a lower bound when the language resolve rate < 0.9", async () => {
    const db = graphDb([statsRow("typescript", 100, 50), statsRow("ruby", 10, 10)]);
    const res = await facadeOver(db).getCallers({ collection: "c", symbolId: "Lonely#run" });

    expect(res).toMatchObject({ callers: [], empty: { reason: "noEdges" } });
    const message = "empty" in res ? res.empty?.message : undefined;
    expect(message).toMatch(/Lonely#run/);
    expect(message).toMatch(/typescript/);
    expect(message).toMatch(/0\.50/);
    expect(message).toMatch(/lower bound/);
  });

  it("noEdges carries no lower-bound note when the language resolve rate is at least 0.9", async () => {
    const res = await facadeOver(graphDb([statsRow("typescript", 100, 95)])).getCallees({
      collection: "c",
      symbolId: "Lonely#run",
    });

    expect(res).toMatchObject({ callees: [], empty: { reason: "noEdges" } });
    expect("empty" in res ? res.empty?.message : undefined).not.toMatch(/lower bound/);
  });

  it("a non-empty answer carries no empty field and runs no diagnostic read", async () => {
    const db = graphDb();
    const res = await facadeOver(db).getCallers({ collection: "c", symbolId: REAL });

    expect(res).toMatchObject({ callers: CALLERS[REAL] });
    expect("empty" in res).toBe(false);
    expect(db.getRunStats).not.toHaveBeenCalled();
    expect(db.lookupSymbolIdsByShortName).not.toHaveBeenCalled();
    expect(db.getCallers).toHaveBeenCalledTimes(1);
  });

  it("an unknown file keeps the legacy message and adds empty.reason unknownFile", async () => {
    const db = {
      getFileImporters: vi.fn().mockResolvedValue({ fileKnown: false, edges: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const facade = new GraphFacade({
      pool: fakePool(db as unknown as ReturnType<typeof graphDb>),
      collectionRegistry: registry,
    });

    const res = await facade.getCallers({ collection: "c", relativePath: "nope.ts" });

    expect(res).toMatchObject({ importers: [], empty: { reason: "unknownFile" } });
    const message = "message" in res ? res.message : undefined;
    expect(message).toMatch(/nope\.ts/);
    expect("empty" in res ? res.empty?.message : undefined).toBe(message);
  });
});
