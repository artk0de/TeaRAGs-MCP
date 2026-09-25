/**
 * GraphFacade#getArchitectureReport (bd tea-rags-mcp-94hd9): reads the graph
 * through the pool's READ handle — the daemon-proxied reader `find_cycles`
 * uses, never a direct DuckDB attach — and closes the handle afterwards.
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
  const acquireReader = vi.fn().mockResolvedValue({ graphDb, symbolTable: {} });
  return { pool: { acquireReader, peek: vi.fn() } as unknown as GraphDbClientPool, acquireReader };
}

describe("GraphFacade#getArchitectureReport", () => {
  it("reads the file dependency graph through the pool reader of the resolved collection and closes it", async () => {
    const graphDb = {
      readFileDependencyGraph: vi.fn().mockResolvedValue({ files: [], edges: [] }),
      readNonPublicMemberEdges: vi.fn().mockResolvedValue([]),
      readTemporalCochangeGraph: vi.fn().mockResolvedValue({ meta: null, edges: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const { pool, acquireReader } = readerPool(graphDb);
    const facade = new GraphFacade({
      pool,
      collectionRegistry: registry,
      resolveActiveCollection: async (name) => `${name}_v3` as never,
    });

    const report = await facade.getArchitectureReport({ collection: "code_x", pathPattern: "src/**" });

    expect(acquireReader).toHaveBeenCalledWith("code_x_v3");
    expect(graphDb.readFileDependencyGraph).toHaveBeenCalledTimes(1);
    expect(graphDb.close).toHaveBeenCalledTimes(1);
    expect(report.pathPattern).toBe("src/**");
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
  });

  it("returns the empty report when the collection has no graph database", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("no such file")),
      hasDatabase: vi.fn().mockReturnValue(false),
    } as unknown as GraphDbClientPool;
    const facade = new GraphFacade({ pool, collectionRegistry: registry });

    const report = await facade.getArchitectureReport({ collection: "code_x" });

    expect(report.violations).toEqual([]);
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
  });

  it("surfaces the failure when the graph database exists but cannot be read", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("lock held")),
      hasDatabase: vi.fn().mockReturnValue(true),
    } as unknown as GraphDbClientPool;
    const facade = new GraphFacade({ pool, collectionRegistry: registry });

    await expect(facade.getArchitectureReport({ collection: "code_x" })).rejects.toThrow(/lock held/);
  });
});
