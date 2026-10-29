/**
 * A class / module id rolls up its members' edges (bd tea-rags-mcp-znzv3).
 * Calls land on members (`Router.call`), never on the container itself, so a
 * container id answered `noEdges` while a member had an exact caller — and an
 * agent concluded "unused". Now get_callers(Container) answers the container's
 * own edges plus every member's callers, each labelled with the member it
 * reaches (`member: ".call"`), one row per caller+member, internal calls
 * between the container's own members left out and counted; get_callees
 * mirrors it per member+target. Depth > 1 trees start from the same rows.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CalleeEdge, CallerEdge, SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const ROUTER = "Shop::Mock::Router";
const MEMBERS = [`${ROUTER}#dispatch`, `${ROUTER}.call`];

const CALLERS: Record<string, CallerEdge[]> = {
  [`${ROUTER}.call`]: [
    {
      sourceSymbolId: "Shop::Mock::Adapter#call",
      sourceRelPath: "lib/shop/mock/adapter.rb",
      callExpression: "Router.call(env)",
      edgeKind: "exact",
      confidence: 1,
    },
    {
      sourceSymbolId: "Shop::Mock::Adapter#call",
      sourceRelPath: "lib/shop/mock/adapter.rb",
      callExpression: "Router.call(env, retry: true)",
      edgeKind: "exact",
      confidence: 1,
    },
  ],
  [`${ROUTER}#dispatch`]: [
    { sourceSymbolId: `${ROUTER}.call`, sourceRelPath: "lib/shop/mock/router.rb", callExpression: "new.dispatch(env)" },
    { sourceSymbolId: "Shop::Api#fetch", sourceRelPath: "lib/shop/api.rb", callExpression: "router.dispatch(env)" },
  ],
  "Shop::Mock::Adapter#call": [
    { sourceSymbolId: "Shop::Client#get", sourceRelPath: "lib/shop/client.rb", callExpression: "adapter.call(env)" },
  ],
};
const CALLEES: Record<string, CalleeEdge[]> = {
  [`${ROUTER}.call`]: [
    {
      targetSymbolId: `${ROUTER}#dispatch`,
      targetRelPath: "lib/shop/mock/router.rb",
      callExpression: "new.dispatch(env)",
    },
  ],
  [`${ROUTER}#dispatch`]: [
    { targetSymbolId: "Shop::Response.ok", targetRelPath: "lib/shop/response.rb", callExpression: "Response.ok(body)" },
    {
      targetSymbolId: "Shop::Response.ok",
      targetRelPath: "lib/shop/response.rb",
      callExpression: "Response.ok(other)",
    },
  ],
};
const SYMBOLS: SymbolVisibilityRow[] = [
  { relPath: "lib/shop/mock/router.rb", symbolId: ROUTER, visibility: null },
  { relPath: "lib/shop/lonely.rb", symbolId: "Shop::Lonely", visibility: null },
];

function bulk<E>(table: Record<string, E[]>) {
  return vi.fn(async (ids: readonly string[]) => {
    const out = new Map<string, E[]>();
    for (const id of ids) if (table[id]) out.set(id, table[id]);
    return out;
  });
}

function graphDb() {
  return {
    getCallers: vi.fn(async (id: string) => CALLERS[id] ?? []),
    getCallees: vi.fn(async (id: string) => CALLEES[id] ?? []),
    getCallersBulk: bulk(CALLERS),
    getCalleesBulk: bulk(CALLEES),
    getContainerMemberSymbolIds: vi.fn(async (id: string) => (id === ROUTER ? MEMBERS : [])),
    getSupertypes: vi.fn(async () => []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => SYMBOLS.filter((r) => ids.includes(r.symbolId))),
    lookupSymbolIdsByShortName: vi.fn(async () => []),
    getRunStats: vi.fn(async () => []),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function facadeOver(db: ReturnType<typeof graphDb>): GraphFacade {
  const pool = {
    acquireReader: vi.fn().mockResolvedValue({ graphDb: db, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
  return new GraphFacade({ pool, collectionRegistry: {} as CollectionRegistry });
}

describe("GraphFacade — container ids roll up their members (znzv3)", () => {
  it("get_callers(Container) lists member callers labelled by member, one row per caller+member, never noEdges", async () => {
    const res = await facadeOver(graphDb()).getCallers({ collection: "c", symbolId: ROUTER });

    expect("empty" in res).toBe(false);
    expect("callers" in res && res.callers).toEqual([
      {
        sourceSymbolId: "Shop::Api#fetch",
        sourceRelPath: "lib/shop/api.rb",
        member: "#dispatch",
        callExpression: "router.dispatch(env)",
      },
      {
        sourceSymbolId: "Shop::Mock::Adapter#call",
        sourceRelPath: "lib/shop/mock/adapter.rb",
        member: ".call",
        callExpression: "Router.call(env)",
        edgeKind: "exact",
        confidence: 1,
      },
    ]);
    expect(res).toMatchObject({ memberRollup: { members: 2, internalCallers: 1 } });
  });

  it("pages the rolled-up rows with the usual limit / truncated contract", async () => {
    const res = await facadeOver(graphDb()).getCallers({ collection: "c", symbolId: ROUTER, limit: 1 });

    expect("callers" in res && res.callers.map((c) => c.sourceSymbolId)).toEqual(["Shop::Api#fetch"]);
    expect(res).toMatchObject({ truncated: { returned: 1, omitted: 1 } });
  });

  it("a depth-2 caller tree starts from the member callers and carries the member on depth-1 rows", async () => {
    const res = await facadeOver(graphDb()).getCallers({ collection: "c", symbolId: ROUTER, depth: 2 });

    expect("tree" in res && res.tree.map((r) => [r.depth, r.parent, r.symbolId, r.member])).toEqual([
      [1, ROUTER, "Shop::Api#fetch", "#dispatch"],
      [1, ROUTER, "Shop::Mock::Adapter#call", ".call"],
      [2, "Shop::Mock::Adapter#call", "Shop::Client#get", undefined],
    ]);
    expect("empty" in res).toBe(false);
  });

  it("get_callees(Container) mirrors it: member callees per member+target, internal calls counted", async () => {
    const res = await facadeOver(graphDb()).getCallees({ collection: "c", symbolId: ROUTER });

    expect("empty" in res).toBe(false);
    expect("callees" in res && res.callees).toEqual([
      {
        member: "#dispatch",
        targetSymbolId: "Shop::Response.ok",
        targetRelPath: "lib/shop/response.rb",
        callExpression: "Response.ok(body)",
        count: 2,
      },
    ]);
    expect(res).toMatchObject({ memberRollup: { members: 2, internalCallees: 1 } });
  });

  it("a container with no member edges stays noEdges, and a member id is never rolled up", async () => {
    const db = graphDb();
    const lonely = await facadeOver(db).getCallers({ collection: "c", symbolId: "Shop::Lonely" });
    expect(lonely).toMatchObject({ callers: [], empty: { reason: "noEdges" } });
    expect("memberRollup" in lonely).toBe(false);

    const member = await facadeOver(db).getCallers({ collection: "c", symbolId: `${ROUTER}.call` });
    expect("memberRollup" in member).toBe(false);
    expect("callers" in member && member.callers).toHaveLength(2);
  });
});
