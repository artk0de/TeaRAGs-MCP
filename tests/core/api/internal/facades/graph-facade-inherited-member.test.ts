/**
 * get_callers / get_callees host-class aliasing (bd tea-rags-mcp-63l69 part 1).
 *
 * Contract under test: when the requested symbolId has no edges and no node of
 * its own, the facade queries the member's DEFINER found up the persisted
 * hierarchy and names it in `resolvedSymbolId`. The field is present exactly
 * when the queried id differs from the requested one — absent on every
 * unaliased answer, so existing responses stay byte-identical.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type {
  CalleeEdge,
  CallerEdge,
  InheritanceEdge,
  SymbolVisibilityRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const DEFINER = "Account::Suspensions.suspended";

const CALLERS: Record<string, CallerEdge[]> = {
  [DEFINER]: [
    { sourceSymbolId: "AccountFilter#status_scope", sourceRelPath: "a.rb", callExpression: "Account.suspended" },
  ],
};
const CALLEES: Record<string, CalleeEdge[]> = {
  [DEFINER]: [{ targetSymbolId: "Account.where", targetRelPath: "account.rb", callExpression: "where(...)" }],
};
const SUPERTYPES: Record<string, InheritanceEdge[]> = {
  Account: [
    {
      sourceFqName: "Account",
      ancestorFqName: "Account::Suspensions",
      ancestorSymbolId: "Account::Suspensions",
      kind: "include",
      depth: 1,
      ordinal: 0,
    },
  ],
};
const SYMBOLS: SymbolVisibilityRow[] = [
  { relPath: "suspensions.rb", symbolId: DEFINER, visibility: null },
  { relPath: "account.rb", symbolId: "Account#own", visibility: null },
];

function graphDb() {
  return {
    getCallers: vi.fn(async (id: string) => CALLERS[id] ?? []),
    getCallees: vi.fn(async (id: string) => CALLEES[id] ?? []),
    getSupertypes: vi.fn(async (fq: string) => SUPERTYPES[fq] ?? []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => SYMBOLS.filter((r) => ids.includes(r.symbolId))),
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

describe("GraphFacade — host-class member aliasing (bd tea-rags-mcp-63l69)", () => {
  it("get_callers on a host id answers the definer's callers and names it in resolvedSymbolId", async () => {
    const db = graphDb();
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Account.suspended" });

    expect(res).toEqual({ resolvedSymbolId: DEFINER, callers: CALLERS[DEFINER] });
    expect(db.getCallers).toHaveBeenLastCalledWith(DEFINER);
  });

  it("get_callees on a host id answers the definer's callees and names it in resolvedSymbolId", async () => {
    const db = graphDb();
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    const res = await facade.getCallees({ collection: "c", symbolId: "Account.suspended" });

    expect(res).toEqual({ resolvedSymbolId: DEFINER, callees: CALLEES[DEFINER] });
  });

  it("the definer id itself is answered directly, without resolvedSymbolId", async () => {
    const db = graphDb();
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: DEFINER });

    expect(res).toEqual({ callers: CALLERS[DEFINER] });
    expect("resolvedSymbolId" in res).toBe(false);
    expect(db.getSupertypes).not.toHaveBeenCalled();
  });

  it("an id with its own node is never aliased, even with no edges", async () => {
    const db = graphDb();
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Account#own" });

    expect(res).toEqual({ callers: [] });
    expect(db.getCallers).toHaveBeenCalledTimes(1);
  });

  it("an id no ancestor defines stays unaliased and empty", async () => {
    const db = graphDb();
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    expect(await facade.getCallees({ collection: "c", symbolId: "Account.missing" })).toEqual({ callees: [] });
  });

  it("includeAmbiguous reads the member segment of the definer", async () => {
    const db = { ...graphDb(), getAmbiguousCallersByMember: vi.fn().mockResolvedValue([]) };
    const facade = new GraphFacade({ pool: fakePool(db), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Account.suspended", includeAmbiguous: true });

    expect(res).toEqual({ resolvedSymbolId: DEFINER, callers: CALLERS[DEFINER], ambiguousCallers: [] });
    expect(db.getAmbiguousCallersByMember).toHaveBeenCalledWith("suspended");
  });
});
