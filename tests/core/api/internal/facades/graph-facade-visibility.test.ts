/**
 * Declared visibility on get_callers / get_callees (bd tea-rags-mcp-sqqkz).
 *
 * Contract under test: `visibility` is present exactly when `cg_symbols` states
 * one for that (relPath, symbolId); a NULL column, a symbol the graph has no
 * definition for, or a lookup that fails all OMIT the field — never `null`,
 * never a default of public. One batched lookup per response.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

/** Fixture graph: Svc#run (public) calls a private, a protected and a NULL-visibility member. */
const ROWS: SymbolVisibilityRow[] = [
  { relPath: "src/svc.ts", symbolId: "Svc#run", visibility: "public" },
  { relPath: "src/svc.ts", symbolId: "Svc#helper", visibility: "private" },
  { relPath: "src/svc.ts", symbolId: "Svc#hook", visibility: "protected" },
  { relPath: "src/svc.ts", symbolId: "Svc#legacy", visibility: null },
  { relPath: "src/api.ts", symbolId: "Api#handle", visibility: "public" },
];

function visibilityDb(rows: SymbolVisibilityRow[]) {
  return vi.fn(async (ids: readonly string[]) => rows.filter((r) => ids.includes(r.symbolId)));
}

function fakePool(graphDb: Record<string, unknown>): GraphDbClientPool {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  return {
    acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
}

const registry = {} as CollectionRegistry;

describe("GraphFacade — declared visibility (bd tea-rags-mcp-sqqkz)", () => {
  it("get_callees: each target carries its visibility when known and omits it when NULL or absent", async () => {
    const getSymbolVisibilities = visibilityDb(ROWS);
    const graphDb = {
      getCallees: vi.fn().mockResolvedValue([
        { targetSymbolId: "Svc#helper", targetRelPath: "src/svc.ts", callExpression: "this.helper()" },
        { targetSymbolId: "Svc#hook", targetRelPath: "src/svc.ts", callExpression: "this.hook()" },
        { targetSymbolId: "Svc#legacy", targetRelPath: "src/svc.ts", callExpression: "this.legacy()" },
        { targetSymbolId: "Ext#call", targetRelPath: "src/ext.ts", callExpression: "ext.call()" },
        { targetSymbolId: null, targetRelPath: "src/util.ts", callExpression: "util()" },
      ]),
      getSymbolVisibilities,
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = await facade.getCallees({ collection: "c", symbolId: "Svc#run" });

    expect(res).toEqual({
      callees: [
        {
          targetSymbolId: "Svc#helper",
          targetRelPath: "src/svc.ts",
          callExpression: "this.helper()",
          visibility: "private",
        },
        {
          targetSymbolId: "Svc#hook",
          targetRelPath: "src/svc.ts",
          callExpression: "this.hook()",
          visibility: "protected",
        },
        { targetSymbolId: "Svc#legacy", targetRelPath: "src/svc.ts", callExpression: "this.legacy()" },
        { targetSymbolId: "Ext#call", targetRelPath: "src/ext.ts", callExpression: "ext.call()" },
        { targetSymbolId: null, targetRelPath: "src/util.ts", callExpression: "util()" },
      ],
    });
    expect("visibility" in (res as { callees: object[] }).callees[2]).toBe(false);
    expect(getSymbolVisibilities).toHaveBeenCalledTimes(1);
  });

  it("get_callers: the queried symbol's visibility is top-level, each caller carries its own", async () => {
    const getSymbolVisibilities = visibilityDb(ROWS);
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([
        { sourceSymbolId: "Svc#run", sourceRelPath: "src/svc.ts", callExpression: "this.helper()" },
        { sourceSymbolId: "Svc#legacy", sourceRelPath: "src/svc.ts", callExpression: "this.helper()" },
      ]),
      getSymbolVisibilities,
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Svc#helper" });

    expect(res).toEqual({
      visibility: "private",
      callers: [
        {
          sourceSymbolId: "Svc#run",
          sourceRelPath: "src/svc.ts",
          callExpression: "this.helper()",
          visibility: "public",
        },
        { sourceSymbolId: "Svc#legacy", sourceRelPath: "src/svc.ts", callExpression: "this.helper()" },
      ],
    });
    expect(getSymbolVisibilities).toHaveBeenCalledTimes(1);
  });

  it("get_callers: a queried symbol with NULL visibility has no top-level field", async () => {
    const graphDb = {
      getCallers: vi
        .fn()
        .mockResolvedValue([
          { sourceSymbolId: "Api#handle", sourceRelPath: "src/api.ts", callExpression: "s.legacy()" },
        ]),
      getSymbolVisibilities: visibilityDb(ROWS),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "c", symbolId: "Svc#legacy" });

    expect("visibility" in res).toBe(false);
    expect(res).toEqual({
      callers: [
        {
          sourceSymbolId: "Api#handle",
          sourceRelPath: "src/api.ts",
          callExpression: "s.legacy()",
          visibility: "public",
        },
      ],
    });
  });

  it("get_callers: namesakes that disagree leave the top-level field out", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([]),
      getSymbolVisibilities: visibilityDb([
        { relPath: "src/a.ts", symbolId: "run", visibility: "public" },
        { relPath: "src/b.ts", symbolId: "run", visibility: "private" },
      ]),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    expect(await facade.getCallers({ collection: "c", symbolId: "run" })).toEqual({ callers: [] });
  });

  it("a failing visibility lookup degrades to the undecorated answer", async () => {
    const edges = [{ sourceSymbolId: "Svc#run", sourceRelPath: "src/svc.ts", callExpression: "this.helper()" }];
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue(edges),
      getSymbolVisibilities: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    expect(await facade.getCallers({ collection: "c", symbolId: "Svc#helper" })).toEqual({ callers: edges });
  });

  it("getSymbolVisibilities reads the rows through the read handle and closes it", async () => {
    const graphDb = { getSymbolVisibilities: visibilityDb(ROWS), close: vi.fn().mockResolvedValue(undefined) };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: registry });

    const rows = await facade.getSymbolVisibilities({ collection: "c" }, ["Svc#helper"]);

    expect(rows).toEqual([{ relPath: "src/svc.ts", symbolId: "Svc#helper", visibility: "private" }]);
    expect(graphDb.close).toHaveBeenCalledTimes(1);
  });
});
