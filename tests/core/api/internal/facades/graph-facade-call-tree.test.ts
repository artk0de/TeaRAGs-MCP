/**
 * GraphFacade `depth` and `offset` on get_callers / get_callees (bd tea-rags-mcp-afdpc): `depth > 1` answers a
 * BFS call tree read one frontier per level; every list pages by `offset` over a stable order and says what it cut.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import { InvalidParameterError } from "../../../../../src/core/api/public/errors.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const registry = {
  findByName: vi.fn(() => null),
  findByPath: vi.fn(() => null),
  list: vi.fn(() => []),
} as unknown as CollectionRegistry;

function facadeOver(graphDb: Record<string, unknown>, signatures: Record<string, string> = {}) {
  graphDb.close ??= vi.fn().mockResolvedValue(undefined);
  const pool = {
    acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
    peek: vi.fn(),
  } as unknown as GraphDbClientPool;
  const readSymbolSignatures = vi.fn(async (_collection: string, ids: readonly string[]) => {
    return new Map(ids.flatMap((id) => (signatures[id] ? [[id, signatures[id]] as const] : [])));
  });
  return {
    facade: new GraphFacade({ pool, collectionRegistry: registry, readSymbolSignatures }),
    readSymbolSignatures,
  };
}

const callee = (target: string | null, extra: Record<string, unknown> = {}) => ({
  targetSymbolId: target,
  targetRelPath: target ? `${target.split("#")[0].toLowerCase()}.ts` : "lib.ts",
  callExpression: `call.${target ?? "ext"}`,
  edgeKind: "exact",
  confidence: 1,
  ...extra,
});
const caller = (source: string) => ({
  sourceSymbolId: source,
  sourceRelPath: `${source.split("#")[0].toLowerCase()}.ts`,
  callExpression: "x.m",
  edgeKind: "exact",
  confidence: 1,
});

function calleeGraph() {
  return {
    getCallees: vi
      .fn()
      .mockResolvedValue([
        callee("A#a"),
        callee("B#b", { edgeKind: "cone", confidence: 0.5 }),
        callee(null, { edgeKind: undefined, confidence: undefined }),
      ]),
    getCalleesBulk: vi.fn(
      async () =>
        new Map([
          ["A#a", [callee("C#c"), callee(null), callee(null)]],
          ["B#b", [callee("A#a"), callee("D#d")]],
        ]),
    ),
  };
}

const ADDR = { collection: "code_x", symbolId: "Root#run" } as const;

describe("GraphFacade#getCallees — depth (afdpc)", () => {
  it("depth 1 answers exactly what the call without depth answers", async () => {
    const { facade } = facadeOver(calleeGraph());
    const plain = await facade.getCallees({ ...ADDR });
    const withDepth = await facade.getCallees({ ...ADDR, depth: 1 });
    expect(withDepth).toEqual(plain);
    expect(plain).not.toHaveProperty("tree");
    expect(plain).not.toHaveProperty("truncated");
  });

  it("depth 2 answers a BFS tree read with one frontier query, signatures attached", async () => {
    const graphDb = calleeGraph();
    const { facade } = facadeOver(graphDb, { "A#a": "async a(): Promise<void> {" });

    const res = await facade.getCallees({ ...ADDR, depth: 2 });

    expect(graphDb.getCalleesBulk).toHaveBeenCalledTimes(1);
    expect(graphDb.getCalleesBulk).toHaveBeenCalledWith(["A#a", "B#b"]);
    expect(res).toEqual({
      tree: [
        {
          depth: 1,
          parent: "Root#run",
          symbolId: "A#a",
          relPath: "a.ts",
          edgeKind: "exact",
          confidence: 1,
          external: 2,
          signature: "async a(): Promise<void> {",
        },
        { depth: 1, parent: "Root#run", symbolId: "B#b", relPath: "b.ts", edgeKind: "cone", confidence: 0.5 },
        { depth: 2, parent: "A#a", symbolId: "C#c", relPath: "c.ts", edgeKind: "exact", confidence: 1 },
        { depth: 2, parent: "B#b", symbolId: "A#a", relPath: "a.ts", edgeKind: "exact", confidence: 1, seen: true },
        { depth: 2, parent: "B#b", symbolId: "D#d", relPath: "d.ts", edgeKind: "exact", confidence: 1 },
      ],
      unresolved: 1,
    });
  });

  it("pages the tree by offset over BFS order: no overlap, no gap, truncated only while rows remain", async () => {
    const { facade } = facadeOver(calleeGraph());
    const full = await facade.getCallees({ ...ADDR, depth: 2 });
    const page1 = await facade.getCallees({ ...ADDR, depth: 2, limit: 2 });
    const page2 = await facade.getCallees({ ...ADDR, depth: 2, limit: 2, offset: 2 });
    const page3 = await facade.getCallees({ ...ADDR, depth: 2, limit: 2, offset: 4 });

    const rows = (r: unknown) => (r as { tree: unknown[] }).tree;
    expect([...rows(page1), ...rows(page2), ...rows(page3)]).toEqual(rows(full));
    expect(page1).toMatchObject({ truncated: { returned: 2, omitted: 3 } });
    expect(page2).toMatchObject({ truncated: { returned: 2, omitted: 1 } });
    expect(page3).not.toHaveProperty("truncated");
  });

  it("caps an unbounded tree at 40 rows by default", async () => {
    const wide = Array.from({ length: 60 }, (_, i) => callee(`N${String(i).padStart(2, "0")}#n`));
    const graphDb = { getCallees: vi.fn().mockResolvedValue(wide), getCalleesBulk: vi.fn(async () => new Map()) };
    const { facade } = facadeOver(graphDb);
    const res = (await facade.getCallees({ ...ADDR, depth: 2 })) as { tree: unknown[]; truncated?: unknown };
    expect(res.tree).toHaveLength(40);
    expect(res.truncated).toEqual({ returned: 40, omitted: 20 });
  });

  it("pages the one-hop list by offset and reports the cut", async () => {
    const { facade } = facadeOver(calleeGraph());
    const page1 = (await facade.getCallees({ ...ADDR, limit: 1 })) as { callees: { targetSymbolId: string }[] };
    const page2 = (await facade.getCallees({ ...ADDR, limit: 1, offset: 1 })) as {
      callees: { targetSymbolId: string }[];
    };
    expect(page1.callees.map((c) => c.targetSymbolId)).toEqual(["A#a"]);
    expect(page1).toMatchObject({ truncated: { returned: 1, omitted: 1 } });
    expect(page2.callees.map((c) => c.targetSymbolId)).toEqual(["B#b"]);
    expect(page2).not.toHaveProperty("truncated");
  });

  it.each([0, 4, 1.5])("rejects depth %s", async (depth) => {
    const { facade } = facadeOver(calleeGraph());
    await expect(facade.getCallees({ ...ADDR, depth })).rejects.toBeInstanceOf(InvalidParameterError);
  });

  it("rejects depth > 1 on a relativePath target", async () => {
    const { facade } = facadeOver(calleeGraph());
    await expect(
      facade.getCallees({ collection: "code_x", relativePath: "src/a.ts", depth: 2 }),
    ).rejects.toBeInstanceOf(InvalidParameterError);
  });
});

describe("GraphFacade#getCallers — depth (afdpc)", () => {
  it("depth 2 answers the reverse tree, a shared caller listed once and back-referenced after", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([caller("X#x"), caller("Y#y")]),
      getCallersBulk: vi.fn(
        async () =>
          new Map([
            ["X#x", [caller("Z#z"), caller("Z#z")]],
            ["Y#y", [caller("Z#z")]],
          ]),
      ),
    };
    const { facade } = facadeOver(graphDb);

    const res = (await facade.getCallers({ ...ADDR, depth: 2 })) as unknown as { tree: Record<string, unknown>[] };

    expect(graphDb.getCallersBulk).toHaveBeenCalledWith(["X#x", "Y#y"]);
    expect(res.tree.map((r) => [r.symbolId, r.parent, r.depth, r.seen ?? false])).toEqual([
      ["X#x", "Root#run", 1, false],
      ["Y#y", "Root#run", 1, false],
      ["Z#z", "X#x", 2, false],
      ["Z#z", "Y#y", 2, true],
    ]);
  });

  it("rejects includeAmbiguous with depth > 1", async () => {
    const { facade } = facadeOver({ getCallers: vi.fn().mockResolvedValue([caller("X#x")]) });
    await expect(facade.getCallers({ ...ADDR, depth: 2, includeAmbiguous: true })).rejects.toBeInstanceOf(
      InvalidParameterError,
    );
  });

  it("pages the importer list of a file by offset", async () => {
    const edges = ["src/a.ts", "src/b.ts", "src/c.ts"].map((source) => ({
      sourceRelPath: source,
      targetRelPath: "src/t.ts",
      importText: null,
      callWeight: 0,
    }));
    const { facade } = facadeOver({ getFileImporters: vi.fn().mockResolvedValue({ fileKnown: true, edges }) });
    const page1 = await facade.getCallers({ collection: "code_x", relativePath: "src/t.ts", limit: 2 });
    const page2 = await facade.getCallers({ collection: "code_x", relativePath: "src/t.ts", limit: 2, offset: 2 });
    expect(page1).toMatchObject({ total: 3, truncated: { returned: 2, omitted: 1 } });
    expect((page2 as { importers: { relativePath: string }[] }).importers.map((i) => i.relativePath)).toEqual([
      "src/c.ts",
    ]);
    expect(page2).not.toHaveProperty("truncated");
  });
});
