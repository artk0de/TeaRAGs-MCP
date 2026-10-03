/**
 * Graph tools carry the `workingTree` marker (bd tea-rags-mcp-xi2r9.1) with
 * `floors: []` — the codegraph has no working-tree floor — on every return
 * path, the `withReadHandle` fallback for a collection with no graph included.
 */

import { describe, expect, it, vi } from "vitest";

import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "a".repeat(40),
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
};

function graphDb() {
  return {
    getCallers: vi.fn().mockResolvedValue([]),
    getCallees: vi.fn().mockResolvedValue([]),
    findCycles: vi.fn().mockResolvedValue([]),
    getFileImporters: vi.fn().mockResolvedValue({ edges: [], fileKnown: true }),
    getFileImports: vi.fn().mockResolvedValue({ edges: [], fileKnown: true }),
    getSymbolVisibilities: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue({ meta: null, edges: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFacade(options: { graph: boolean }) {
  const overlay = {
    view: vi.fn().mockResolvedValue({ marker: MARKER, touchedPaths: new Set(), deletedPaths: new Set() }),
  };
  const pool = {
    acquireReader: options.graph
      ? vi.fn().mockResolvedValue({ graphDb: graphDb() })
      : vi.fn().mockRejectedValue(new Error("no such file")),
    hasDatabase: vi.fn().mockReturnValue(options.graph),
  };
  const facade = new GraphFacade({
    pool: pool as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (c: string) => c as never,
    workingTreeOverlay: overlay,
  });
  return { facade, overlay };
}

describe("GraphFacade workingTree marker", () => {
  for (const graph of [true, false]) {
    const branch = graph ? "a graph read" : "the no-graph fallback";

    it(`should attach the marker to get_callers on ${branch}`, async () => {
      const { facade } = makeFacade({ graph });

      const response = await facade.getCallers({ collection: "code_x", symbolId: "A#b" });

      expect(response.workingTree).toEqual(MARKER);
      expect(response.workingTree?.floors).toEqual([]);
    });

    it(`should attach the marker to a file-scoped get_callers on ${branch}`, async () => {
      const { facade } = makeFacade({ graph });

      const response = await facade.getCallers({ collection: "code_x", relativePath: "src/a.ts" });

      expect(response.workingTree).toEqual(MARKER);
    });

    it(`should attach the marker to get_callees on ${branch}`, async () => {
      const { facade } = makeFacade({ graph });

      const symbol = await facade.getCallees({ collection: "code_x", symbolId: "A#b" });
      const file = await facade.getCallees({ collection: "code_x", relativePath: "src/a.ts" });

      expect(symbol.workingTree).toEqual(MARKER);
      expect(file.workingTree).toEqual(MARKER);
    });

    it(`should attach the marker to find_cycles on ${branch}`, async () => {
      const { facade } = makeFacade({ graph });

      const response = await facade.findCycles({ collection: "code_x", scope: "file" });

      expect(response.workingTree).toEqual(MARKER);
    });

    // Live D9: co-change is git history — it reads the index's temporal graph
    // whatever the tree holds, and says which tree it answered beside.
    it(`should attach the marker to find_co_changed on ${branch}`, async () => {
      const { facade } = makeFacade({ graph });

      const response = await facade.findCoChanged({ collection: "code_x", files: ["src/a.ts"] });

      expect(response.workingTree).toEqual(MARKER);
    });
  }

  it("should answer find_co_changed from the index's history without asking for the tree graph", async () => {
    const readTreeGraph = vi.fn(async () => ({
      kind: "built" as const,
      dbPath: "/t.duckdb",
      physicalCollectionName: "c",
    }));
    const view = {
      marker: { ...MARKER, changedFiles: 1, floors: [] },
      touchedPaths: new Set(["src/a.ts"]),
      deletedPaths: new Set(),
      readTreeGraph,
    };
    const pool = {
      acquireReader: vi.fn().mockResolvedValue({ graphDb: graphDb() }),
      acquireFileReader: vi.fn(),
      hasDatabase: vi.fn().mockReturnValue(true),
    };
    const facade = new GraphFacade({
      pool: pool as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (c: string) => c as never,
      workingTreeOverlay: { view: vi.fn().mockResolvedValue(view) },
    });

    const response = await facade.findCoChanged({ collection: "code_x", files: ["src/a.ts"] });

    expect(readTreeGraph).not.toHaveBeenCalled();
    expect(pool.acquireFileReader).not.toHaveBeenCalled();
    expect(response.workingTree?.floors).toEqual([]);
    expect(response.workingTree?.treeGraphUnavailable).toBeUndefined();
  });

  it("should hand the overlay the resolved tree and the caller's alias", async () => {
    const { facade, overlay } = makeFacade({ graph: true });

    await facade.getCallers({ collection: "code_x", symbolId: "A#b" });

    expect(overlay.view).toHaveBeenCalledWith(
      { root: "", baseIndex: { collectionName: "code_x", root: undefined } },
      undefined,
    );
  });
});
