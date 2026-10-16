/**
 * GraphFacade#findCycles (bd tea-rags-mcp-2m83f.40): a cycle a residual model
 * closes reaches the DTO with `hasModelEdge` + `modelEdgeCount`; an all-static
 * cycle carries neither.
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

describe("GraphFacade#findCycles — model provenance", () => {
  it("passes a cycle's model hops through and leaves a static cycle unmarked", async () => {
    const graphDb = {
      findCycles: vi.fn().mockResolvedValue([
        { cycleId: 0, scope: "file", members: ["a.rb", "b.rb"], hasModelEdge: true, modelEdgeCount: 1 },
        { cycleId: 1, scope: "file", members: ["c.rb", "d.rb"] },
      ]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const pool = {
      acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
      peek: vi.fn(),
    } as unknown as GraphDbClientPool;
    const facade = new GraphFacade({
      pool,
      collectionRegistry: registry,
      resolveActiveCollection: async (name) => `${name}_v3` as never,
    });

    const res = await facade.findCycles({ collection: "code_x", scope: "file" });

    expect(res.cycles).toEqual([
      { cycleId: 0, scope: "file", members: ["a.rb", "b.rb"], length: 2, hasModelEdge: true, modelEdgeCount: 1 },
      { cycleId: 1, scope: "file", members: ["c.rb", "d.rb"], length: 2 },
    ]);
  });
});
