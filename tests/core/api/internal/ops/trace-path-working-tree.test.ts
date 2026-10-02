/**
 * `trace_path` carries the `workingTree` marker (bd tea-rags-mcp-xi2r9.1) with
 * `floors: []` on every return path: a traced path, an endpoint the graph does
 * not know, and the no-graph fallback.
 */

import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: null,
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
  degraded: { reason: "index has no indexedCommit stamp", remedy: "tea-rags index-codebase --project p" },
};

function graphDb() {
  const adjacency: Record<string, string[]> = { A: ["B"], B: [] };
  return {
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        out.set(
          fileScopedSymbolKey(ref),
          (adjacency[ref.symbolId] ?? []).map((symbolId) => ({ relPath: `${symbolId}.ts`, symbolId })),
        );
      }
      return out;
    }),
    getSymbolRelPaths: vi.fn(
      async (ids: string[]) => new Map(ids.filter((id) => id in adjacency).map((id) => [id, [`${id}.ts`]])),
    ),
    getSymbolVisibilities: vi.fn().mockResolvedValue([]),
    close: vi.fn(async () => undefined),
  };
}

function makeOps(options: { graph: boolean }) {
  const overlay = {
    view: vi.fn().mockResolvedValue({ marker: MARKER, touchedPaths: new Set(), deletedPaths: new Set() }),
  };
  const pool = {
    acquireReader: options.graph
      ? vi.fn(async () => ({ graphDb: graphDb(), symbolTable: {} }))
      : vi.fn().mockRejectedValue(new Error("no such file")),
    hasDatabase: vi.fn().mockReturnValue(options.graph),
  };
  const qdrant = { scrollBySymbolIds: vi.fn().mockResolvedValue([]) };
  const ops = new TracePathOps({
    pool: pool as never,
    qdrant: qdrant as never,
    reranker: { rerank: vi.fn() } as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    workingTreeOverlay: overlay,
  });
  return { ops, overlay };
}

describe("TracePathOps workingTree marker", () => {
  it("should attach the marker to a traced path", async () => {
    const { ops } = makeOps({ graph: true });

    const result = await ops.tracePath({ collection: "c", from: "A", to: "B" });

    expect(result.paths).toHaveLength(1);
    expect(result.workingTree).toEqual(MARKER);
  });

  it("should attach the marker when an endpoint is unknown to the graph", async () => {
    const { ops } = makeOps({ graph: true });

    const result = await ops.tracePath({ collection: "c", from: "A", to: "Missing" });

    expect(result.paths).toEqual([]);
    expect(result.workingTree).toEqual(MARKER);
  });

  it("should attach the marker on the no-graph fallback", async () => {
    const { ops } = makeOps({ graph: false });

    const result = await ops.tracePath({ collection: "c", from: "A", to: "B" });

    expect(result).toMatchObject({ paths: [], truncated: false });
    expect(result.workingTree).toEqual(MARKER);
  });

  it("should hand the overlay the resolved tree and the caller's alias", async () => {
    const { ops, overlay } = makeOps({ graph: true });

    await ops.tracePath({ collection: "c", from: "A", to: "B" });

    expect(overlay.view).toHaveBeenCalledWith(
      { root: "", baseIndex: { collectionName: "c", root: undefined } },
      undefined,
    );
  });
});
