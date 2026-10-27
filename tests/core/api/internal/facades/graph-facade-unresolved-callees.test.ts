import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

function fakePool(graphDb: Record<string, unknown>): GraphDbClientPool {
  graphDb.close ??= vi.fn().mockResolvedValue(undefined);
  return {
    acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
}

const registry = {} as CollectionRegistry;

describe("GraphFacade#getCallees — unresolved calls do not occupy rows", () => {
  it("moves null-target edges out of `callees` into `unresolved` + `unresolvedCalls`", async () => {
    const graphDb = {
      getCallees: vi.fn().mockResolvedValue([
        { targetSymbolId: null, targetRelPath: "app/models/user.rb", callExpression: "survivor.present?" },
        { targetSymbolId: "Svc#helper", targetRelPath: "src/svc.ts", callExpression: "this.helper()" },
        { targetSymbolId: null, targetRelPath: "app/models/user.rb", callExpression: "owner.nil?" },
        { targetSymbolId: null, targetRelPath: "app/models/user.rb", callExpression: "owner.nil?" },
      ]),
      getSymbolVisibilities: vi.fn().mockResolvedValue([]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = (await facade.getCallees({ collection: "c", symbolId: "Svc#run" })) as unknown as Record<
      string,
      unknown
    >;

    expect(res.callees).toEqual([
      { targetSymbolId: "Svc#helper", targetRelPath: "src/svc.ts", callExpression: "this.helper()" },
    ]);
    expect(res.unresolved).toBe(3);
    expect(res.unresolvedCalls).toEqual(["survivor.present?", "owner.nil?"]);
  });

  it("caps `unresolvedCalls` at 5 distinct names while `unresolved` counts every site", async () => {
    const edges = Array.from({ length: 8 }, (_, i) => ({
      targetSymbolId: null,
      targetRelPath: "a.rb",
      callExpression: `e.m${i}`,
    }));
    const graphDb = { getCallees: vi.fn().mockResolvedValue(edges), getSymbolVisibilities: vi.fn() };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = (await facade.getCallees({ collection: "c", symbolId: "X#y" })) as unknown as Record<string, unknown>;

    expect(res.unresolved).toBe(8);
    expect(res.unresolvedCalls).toHaveLength(5);
  });

  it("omits both fields when every edge is resolved", async () => {
    const graphDb = {
      getCallees: vi
        .fn()
        .mockResolvedValue([{ targetSymbolId: "A#b", targetRelPath: "a.ts", callExpression: "a.b()" }]),
      getSymbolVisibilities: vi.fn().mockResolvedValue([]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = (await facade.getCallees({ collection: "c", symbolId: "X#y" })) as unknown as Record<string, unknown>;

    expect("unresolved" in res).toBe(false);
    expect("unresolvedCalls" in res).toBe(false);
  });

  it("applies `limit` to resolved rows only", async () => {
    const graphDb = {
      getCallees: vi.fn().mockResolvedValue([
        { targetSymbolId: null, targetRelPath: "a.rb", callExpression: "e.code" },
        { targetSymbolId: "A#b", targetRelPath: "a.ts", callExpression: "a.b()" },
        { targetSymbolId: "A#c", targetRelPath: "a.ts", callExpression: "a.c()" },
      ]),
      getSymbolVisibilities: vi.fn().mockResolvedValue([]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = (await facade.getCallees({ collection: "c", symbolId: "X#y", limit: 2 })) as {
      callees: { targetSymbolId: string }[];
    };

    expect(res.callees.map((c) => c.targetSymbolId)).toEqual(["A#b", "A#c"]);
  });
});
