/**
 * Graph answers for ids the graph cannot answer directly:
 *
 * - both separator forms exist (`Registry#client_for` instance + `Registry.client_for` module function) and only
 *   the other one carries edges → the answer is the other form's, named in `resolvedSymbolId`;
 * - the id is an indexed TEST chunk (the graph holds no node for test code) → `empty.reason: "testChunk"`;
 * - callee rows reaching one target symbol collapse into one row with a `count`.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CalleeEdge, CallerEdge, SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const SYMBOLS: SymbolVisibilityRow[] = [
  { relPath: "lib/registry.rb", symbolId: "Registry#client_for", visibility: null },
  { relPath: "lib/registry.rb", symbolId: "Registry.client_for", visibility: null },
];
const CALLERS: Record<string, CallerEdge[]> = {
  "Registry.client_for": [
    { sourceSymbolId: "App#boot", sourceRelPath: "lib/app.rb", callExpression: "Registry.client_for(x)" },
  ],
};
const CALLEES: Record<string, CalleeEdge[]> = {
  "Registry.client_for": [{ targetSymbolId: "Http#get", targetRelPath: "lib/http.rb", callExpression: "http.get" }],
};

function graphDb() {
  return {
    getCallers: vi.fn(async (id: string) => CALLERS[id] ?? []),
    getCallees: vi.fn(async (id: string) => CALLEES[id] ?? []),
    getSupertypes: vi.fn(async () => []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => SYMBOLS.filter((r) => ids.includes(r.symbolId))),
    lookupSymbolIdsByShortName: vi.fn(async () => []),
    getRunStats: vi.fn(async () => []),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function pool(db: ReturnType<typeof graphDb>): GraphDbClientPool {
  return {
    acquireReader: vi.fn().mockResolvedValue({ graphDb: db, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
}

const registry = {} as CollectionRegistry;

describe("GraphFacade — both separator forms exist, only one has edges", () => {
  it("get_callers on the edgeless form answers the other form and names it in resolvedSymbolId", async () => {
    const facade = new GraphFacade({ pool: pool(graphDb()), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Registry#client_for" });

    expect(res).toMatchObject({ resolvedSymbolId: "Registry.client_for", callers: CALLERS["Registry.client_for"] });
    expect("empty" in res).toBe(false);
  });

  it("get_callees on the edgeless form answers the other form and names it in resolvedSymbolId", async () => {
    const facade = new GraphFacade({ pool: pool(graphDb()), collectionRegistry: registry });

    const res = await facade.getCallees({ collection: "c", symbolId: "Registry#client_for" });

    expect(res).toMatchObject({ resolvedSymbolId: "Registry.client_for" });
    expect((res as { callees: unknown[] }).callees).toHaveLength(1);
  });

  it("when neither form has edges the queried form stays noEdges", async () => {
    const facade = new GraphFacade({ pool: pool(graphDb()), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Registry.other" });

    expect(res).toMatchObject({ callers: [] });
  });
});

describe("GraphFacade — an indexed test chunk is not a graph node", () => {
  it("answers empty.reason testChunk instead of unknownSymbol", async () => {
    const readSymbolIsTest = vi.fn(async (_collection: string, symbolId: string) => symbolId === "describe_widget");
    const facade = new GraphFacade({ pool: pool(graphDb()), collectionRegistry: registry, readSymbolIsTest });

    const res = await facade.getCallers({ collection: "c", symbolId: "describe_widget" });

    expect((res as { empty?: { reason: string; message: string } }).empty?.reason).toBe("testChunk");
    expect((res as { empty?: { message: string } }).empty?.message).toContain("test chunk");
  });

  it("keeps unknownSymbol when the probe says the id is not a test chunk", async () => {
    const readSymbolIsTest = vi.fn(async () => false);
    const facade = new GraphFacade({ pool: pool(graphDb()), collectionRegistry: registry, readSymbolIsTest });

    const res = await facade.getCallees({ collection: "c", symbolId: "Nowhere#x" });

    expect((res as { empty?: { reason: string } }).empty?.reason).toBe("unknownSymbol");
  });
});

describe("GraphFacade#getCallees — identical targets collapse", () => {
  it("merges rows of one targetSymbolId into one row carrying `count`", async () => {
    const db = graphDb();
    db.getCallees.mockResolvedValue([
      { targetSymbolId: "Http#get", targetRelPath: "lib/http.rb", callExpression: "http.get(a)" },
      { targetSymbolId: "Log#info", targetRelPath: "lib/log.rb", callExpression: "log.info" },
      { targetSymbolId: "Http#get", targetRelPath: "lib/http.rb", callExpression: "http.get(b)" },
      { targetSymbolId: "Http#get", targetRelPath: "lib/http.rb", callExpression: "http.get(c)" },
    ]);
    const facade = new GraphFacade({ pool: pool(db), collectionRegistry: registry });

    const res = (await facade.getCallees({ collection: "c", symbolId: "X#y" })) as {
      callees: { targetSymbolId: string; callExpression: string; count?: number }[];
    };

    expect(res.callees).toEqual([
      { targetSymbolId: "Http#get", targetRelPath: "lib/http.rb", callExpression: "http.get(a)", count: 3 },
      { targetSymbolId: "Log#info", targetRelPath: "lib/log.rb", callExpression: "log.info" },
    ]);
  });
});
