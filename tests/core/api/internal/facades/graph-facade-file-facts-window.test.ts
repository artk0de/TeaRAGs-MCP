/**
 * GraphFacade architecture reads share ONE Qdrant file-facts scroll per call
 * (bd tea-rags-mcp-2i7lg): the report reads the maintenance readings and the
 * indexed imports, and the request window makes both ride one scan.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import { RequestScopedFileFactsReader } from "../../../../../src/core/api/internal/infra/payload-file-facts-reader.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const registry = {
  findByName: vi.fn(() => null),
  findByPath: vi.fn(() => null),
  list: vi.fn(() => []),
} as unknown as CollectionRegistry;

const PAGES = [[{ id: 1, payload: { relativePath: "src/a.ts", imports: ["./b"], git: { file: { commitCount: 3 } } } }]];

const file = (relPath: string) => ({ relPath, language: "typescript", symbolCount: 1 });

function graphDb() {
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue({
      files: [file("src/a/x.ts"), file("src/b/y.ts")],
      edges: [
        { sourceRelPath: "src/a/x.ts", targetRelPath: "src/b/y.ts", callWeight: 1 },
        { sourceRelPath: "src/b/y.ts", targetRelPath: "src/a/x.ts", callWeight: 1 },
      ],
    }),
    readTypeNameRows: vi.fn().mockResolvedValue([]),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue({ meta: null, edges: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function build(windowed: boolean) {
  const scrollPayloadPages = vi.fn(async function* (_c: string, _k: string[]) {
    yield* PAGES;
  });
  const facts = new RequestScopedFileFactsReader({ scrollPayloadPages });
  const pool = {
    acquireReader: vi.fn().mockImplementation(async () => ({ graphDb: graphDb(), symbolTable: {} })),
    peek: vi.fn(),
  } as unknown as GraphDbClientPool;
  const facade = new GraphFacade({
    pool,
    collectionRegistry: registry,
    readFileMaintenanceSignals: async (c) => facts.readFileMaintenanceSignals(c),
    readIndexedFileImports: async (c) => facts.readIndexedFileImports(c),
    ...(windowed ? { withinRequest: async (fn) => facts.withinRequest(fn) } : {}),
  });
  return { facade, scrollPayloadPages };
}

describe("GraphFacade architecture reads: one file-facts scroll per call", () => {
  it("getArchitectureReport scrolls once when both facts are read", async () => {
    const { facade, scrollPayloadPages } = build(true);
    await facade.getArchitectureReport({ collection: "code_x" });
    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
  });

  it("simulateArchitectureRestructure scrolls once when both facts are read", async () => {
    const { facade, scrollPayloadPages } = build(true);
    await facade.simulateArchitectureRestructure({
      collection: "code_x",
      restructure: [{ move: { files: ["src/b/y.ts"], toComponent: "src/a" } }],
    });
    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
  });

  it("without a window each fact keeps its own scroll", async () => {
    const { facade, scrollPayloadPages } = build(false);
    await facade.getArchitectureReport({ collection: "code_x" });
    expect(scrollPayloadPages).toHaveBeenCalledTimes(2);
  });
});
