/**
 * GraphFacade file scope (bd tea-rags-mcp-gfvr8): `getCallers` / `getCallees`
 * given a `relativePath` instead of a `symbolId` answer from the FILE edge
 * table — the files importing it / the files it imports — read through the
 * pool reader of the PHYSICAL collection, like every other graph read.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const registry = {
  findByName: vi.fn(() => null),
  findByPath: vi.fn(() => null),
  list: vi.fn(() => []),
} as unknown as CollectionRegistry;

function readerPool(graphDb: Record<string, unknown>) {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  const acquireReader = vi.fn().mockResolvedValue({ graphDb, symbolTable: {} });
  return { pool: { acquireReader, peek: vi.fn() } as unknown as GraphDbClientPool, acquireReader };
}

const edge = (source: string, target: string, callWeight: number, importText: string | null = null) => ({
  sourceRelPath: source,
  targetRelPath: target,
  importText,
  callWeight,
});

describe("GraphFacade#getCallers — file scope", () => {
  it("returns the importer files of the physical collection, heaviest dependency first", async () => {
    const graphDb = {
      getFileImporters: vi.fn().mockResolvedValue({
        fileKnown: true,
        edges: [
          edge("src/z.ts", "src/b.ts", 0, "./b"),
          edge("src/a.ts", "src/b.ts", 2.5, "./b.js"),
          edge("src/c.ts", "src/b.ts", 0),
        ],
      }),
      getCallers: vi.fn(),
    };
    const { pool, acquireReader } = readerPool(graphDb);
    const facade = new GraphFacade({
      pool,
      collectionRegistry: registry,
      resolveActiveCollection: async (name) => `${name}_v3` as never,
    });

    const res = await facade.getCallers({ collection: "code_x", relativePath: "src/b.ts" });

    expect(acquireReader).toHaveBeenCalledWith("code_x_v3");
    expect(graphDb.getFileImporters).toHaveBeenCalledWith("src/b.ts");
    expect(graphDb.getCallers).not.toHaveBeenCalled();
    expect(graphDb.close).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      relativePath: "src/b.ts",
      importers: [
        { relativePath: "src/a.ts", importText: "./b.js", callWeight: 2.5 },
        { relativePath: "src/c.ts", importText: null, callWeight: 0 },
        { relativePath: "src/z.ts", importText: "./b", callWeight: 0 },
      ],
      total: 3,
    });
  });

  it("applies limit after ordering and reports the untruncated total", async () => {
    const graphDb = {
      getFileImporters: vi.fn().mockResolvedValue({
        fileKnown: true,
        edges: [edge("a.ts", "t.ts", 0), edge("b.ts", "t.ts", 3), edge("c.ts", "t.ts", 1)],
      }),
    };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "code_x", relativePath: "t.ts", limit: 2 });

    expect("importers" in res && res.importers.map((i) => i.relativePath)).toEqual(["b.ts", "c.ts"]);
    expect("total" in res && res.total).toBe(2 + 1);
  });

  it("strips a leading ./ from the relative path", async () => {
    const graphDb = { getFileImporters: vi.fn().mockResolvedValue({ fileKnown: true, edges: [] }) };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "code_x", relativePath: "./src/b.ts" });

    expect(graphDb.getFileImporters).toHaveBeenCalledWith("src/b.ts");
    expect(res).toEqual({ relativePath: "src/b.ts", importers: [], total: 0 });
  });

  it("answers an unknown file with empty importers and a message naming the path, not an error", async () => {
    const graphDb = { getFileImporters: vi.fn().mockResolvedValue({ fileKnown: false, edges: [] }) };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "code_x", relativePath: "nope.ts" });

    expect(res).toMatchObject({ relativePath: "nope.ts", importers: [], total: 0 });
    expect("message" in res ? res.message : undefined).toMatch(/nope\.ts/);
  });

  it("rejects a request naming both symbolId and relativePath", async () => {
    const facade = new GraphFacade({ pool: readerPool({}).pool, collectionRegistry: registry });
    await expect(facade.getCallers({ collection: "code_x", symbolId: "A#b", relativePath: "a.ts" })).rejects.toThrow(
      /symbolId.*relativePath|relativePath.*symbolId/,
    );
  });

  it("rejects a request naming neither symbolId nor relativePath", async () => {
    const facade = new GraphFacade({ pool: readerPool({}).pool, collectionRegistry: registry });
    await expect(facade.getCallers({ collection: "code_x" })).rejects.toThrow(/symbolId.*relativePath/);
  });

  it("keeps the symbol path unchanged when symbolId is given", async () => {
    const graphDb = {
      getCallers: vi
        .fn()
        .mockResolvedValue([{ sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "t()" }]),
      getFileImporters: vi.fn(),
    };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallers({ collection: "code_x", symbolId: "T#m" });

    expect(res).toEqual({ callers: [{ sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "t()" }] });
    expect(graphDb.getFileImporters).not.toHaveBeenCalled();
  });

  it("returns empty importers when the collection has no graph database", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("no such file")),
      hasDatabase: vi.fn().mockReturnValue(false),
    } as unknown as GraphDbClientPool;
    const facade = new GraphFacade({ pool, collectionRegistry: registry });

    expect(await facade.getCallers({ collection: "code_x", relativePath: "a.ts" })).toMatchObject({
      relativePath: "a.ts",
      importers: [],
      total: 0,
    });
  });
});

describe("GraphFacade#getCallees — file scope", () => {
  it("returns the files the file imports from the physical collection", async () => {
    const graphDb = {
      getFileImports: vi.fn().mockResolvedValue({
        fileKnown: true,
        edges: [edge("src/a.ts", "gen/ghost.ts", 0, "../gen/ghost.js"), edge("src/a.ts", "src/b.ts", 1.5, "./b.js")],
      }),
      getCallees: vi.fn(),
    };
    const { pool, acquireReader } = readerPool(graphDb);
    const facade = new GraphFacade({
      pool,
      collectionRegistry: registry,
      resolveActiveCollection: async (name) => `${name}_v7` as never,
    });

    const res = await facade.getCallees({ collection: "code_x", relativePath: "src/a.ts" });

    expect(acquireReader).toHaveBeenCalledWith("code_x_v7");
    expect(graphDb.getFileImports).toHaveBeenCalledWith("src/a.ts");
    expect(graphDb.getCallees).not.toHaveBeenCalled();
    expect(res).toEqual({
      relativePath: "src/a.ts",
      imports: [
        { relativePath: "src/b.ts", importText: "./b.js", callWeight: 1.5 },
        { relativePath: "gen/ghost.ts", importText: "../gen/ghost.js", callWeight: 0 },
      ],
      total: 2,
    });
  });

  it("answers an unknown file with empty imports and a message, not an error", async () => {
    const graphDb = { getFileImports: vi.fn().mockResolvedValue({ fileKnown: false, edges: [] }) };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallees({ collection: "code_x", relativePath: "nope.ts" });

    expect(res).toMatchObject({ relativePath: "nope.ts", imports: [], total: 0 });
    expect("message" in res ? res.message : undefined).toMatch(/nope\.ts/);
  });

  it("keeps the symbol path unchanged when symbolId is given", async () => {
    const graphDb = {
      getCallees: vi.fn().mockResolvedValue([{ targetSymbolId: "B#x", targetRelPath: "b.ts", callExpression: "x()" }]),
      getFileImports: vi.fn(),
    };
    const facade = new GraphFacade({ pool: readerPool(graphDb).pool, collectionRegistry: registry });

    const res = await facade.getCallees({ collection: "code_x", symbolId: "A#run" });

    expect(res).toEqual({ callees: [{ targetSymbolId: "B#x", targetRelPath: "b.ts", callExpression: "x()" }] });
    expect(graphDb.getFileImports).not.toHaveBeenCalled();
  });

  it("rejects a request naming neither symbolId nor relativePath", async () => {
    const facade = new GraphFacade({ pool: readerPool({}).pool, collectionRegistry: registry });
    await expect(facade.getCallees({ collection: "code_x" })).rejects.toThrow(/symbolId.*relativePath/);
  });
});
