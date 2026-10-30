/**
 * GraphFacade#getContainerAncestors (bd tea-rags-mcp-82cot) — the direct
 * ancestors of each container a find_symbol outline names, read from the
 * persisted hierarchy and returned in MRO order per container (prepend ▸
 * include/extend ▸ implements ▸ super, declaration ordinal within a kind).
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { InheritanceEdge } from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const row = (source: string, ancestor: string, kind: InheritanceEdge["kind"], ordinal = 0): InheritanceEdge => ({
  sourceFqName: source,
  ancestorFqName: ancestor,
  ancestorSymbolId: ancestor,
  kind,
  depth: 1,
  ordinal,
});

const SUPERTYPES: Record<string, InheritanceEdge[]> = {
  Svc: [row("Svc", "Base", "super"), row("Svc", "Concern", "include", 0), row("Svc", "Audited", "prepend")],
  Job: [row("Job", "Worker", "super")],
};

function fakePool(graphDb: Record<string, unknown>): GraphDbClientPool {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  return {
    acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
}

const registry = {} as CollectionRegistry;

describe("GraphFacade#getContainerAncestors (bd tea-rags-mcp-82cot)", () => {
  it("returns each container's direct ancestors in MRO order, through one read handle", async () => {
    const getSupertypes = vi.fn(async (fq: string) => SUPERTYPES[fq] ?? []);
    const pool = fakePool({ getSupertypes });
    const facade = new GraphFacade({ pool, collectionRegistry: registry });

    const rows = await facade.getContainerAncestors({ collection: "c" }, ["Svc", "Job", "Lonely"]);

    expect(rows.map((r) => `${r.sourceFqName} ${r.kind} ${r.ancestorFqName}`)).toEqual([
      "Svc prepend Audited",
      "Svc include Concern",
      "Svc super Base",
      "Job super Worker",
    ]);
    expect(getSupertypes).toHaveBeenCalledTimes(3);
    expect(pool.acquireReader).toHaveBeenCalledTimes(1);
  });
});
