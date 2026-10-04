/**
 * `trace_path` steps hydrate for the working tree (live D2, bd
 * tea-rags-mcp-xi2r9): a step in a file the tree changed takes its lines and
 * its danger overlay from the tree's delta rows of the same symbol (`#partN`
 * windows merged, as find_symbol merges them); a step in a file the tree
 * deleted takes the graph's range and no overlay. The index's payload of a
 * touched file never reaches a step — it describes another commit.
 */

import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 1,
  floors: [],
};

/** A (A.ts, changed) → B (B.ts, untouched) → C (C.ts, deleted). */
function graphDb() {
  const adjacency: Record<string, string[]> = { A: ["B"], B: ["C"], C: [] };
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
    getSymbolLineRangesBulk: vi.fn(
      async () =>
        new Map([
          ["A.ts", { rowsWithoutRanges: 0, ranges: [{ symbolId: "A", startLine: 10, endLine: 12 }] }],
          ["C.ts", { rowsWithoutRanges: 0, ranges: [{ symbolId: "C", startLine: 1, endLine: 3 }] }],
        ]),
    ),
    close: vi.fn(async () => undefined),
  };
}

const row = (id: string, payload: Record<string, unknown>): ScrollChunk => ({ id, payload });

/** The index's chunks: every step's file, the touched ones included. */
const BASE_CHUNKS = [
  row("base-a", { symbolId: "A", relativePath: "A.ts", startLine: 10, endLine: 12, imports: ["./base-import"] }),
  row("base-b", { symbolId: "B", relativePath: "B.ts", startLine: 5, endLine: 6, imports: ["./b"] }),
  row("base-c", { symbolId: "C", relativePath: "C.ts", startLine: 100, endLine: 110, imports: ["./c"] }),
];

/** The tree's rows of A.ts: A split into two windows, plus an unrelated symbol. */
const DELTA_ROWS = [
  row("tree-a1", { symbolId: "A#part1", relativePath: "A.ts", startLine: 14, endLine: 20, imports: ["./tree-import"] }),
  row("tree-a2", { symbolId: "A#part2", relativePath: "A.ts", startLine: 21, endLine: 30, imports: ["./tree-import"] }),
  row("tree-z", { symbolId: "Z", relativePath: "A.ts", startLine: 1, endLine: 8 }),
];

function makeOps(view: WorkingTreeView) {
  const pool = {
    acquireReader: vi.fn(async () => ({ graphDb: graphDb(), symbolTable: {} })),
    hasDatabase: vi.fn().mockReturnValue(true),
  };
  const qdrant = { scrollBySymbolIds: vi.fn().mockResolvedValue(BASE_CHUNKS) };
  // Annotate-only rerank: the overlay echoes the payload the step was ranked on.
  const reranker = {
    rerank: vi.fn(async (results: { id: string; payload: Record<string, unknown> }[]) =>
      results.map((r) => ({
        ...r,
        score: 0.5,
        rankingOverlay: { preset: "hotspots", file: { imports: r.payload.imports } },
      })),
    ),
  };
  return new TracePathOps({
    pool: pool as never,
    qdrant: qdrant as never,
    reranker: reranker as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    workingTreeOverlay: { view: vi.fn().mockResolvedValue(view) },
  });
}

function treeView(rows: ScrollChunk[] | null = DELTA_ROWS): WorkingTreeView {
  const view: WorkingTreeView = {
    marker: { ...MARKER, floors: [] },
    touchedPaths: new Set(["A.ts", "C.ts"]),
    deletedPaths: new Set(["C.ts"]),
  };
  if (rows) view.readDeltaChunks = async () => rows;
  return view;
}

const stepsOf = (result: Awaited<ReturnType<TracePathOps["tracePath"]>>) =>
  result.paths[0].steps.map((s) => ({ symbolId: s.symbolId, startLine: s.startLine, endLine: s.endLine }));

describe("TracePathOps step hydration on a working tree (D2)", () => {
  it("takes a changed file's step lines from the tree's rows, parts merged", async () => {
    const result = await makeOps(treeView()).tracePath({ collection: "c", from: "A", to: "C" });

    expect(stepsOf(result)).toEqual([
      { symbolId: "A", startLine: 14, endLine: 30 },
      { symbolId: "B", startLine: 5, endLine: 6 },
      { symbolId: "C", startLine: 1, endLine: 3 },
    ]);
  });

  it("ranks a changed file's step on the tree's payload and gives a deleted file's step no overlay", async () => {
    const result = await makeOps(treeView()).tracePath({ collection: "c", from: "A", to: "C", rerank: "hotspots" });

    const [a, b, c] = result.paths[0].steps;
    expect(a.dangerOverlay?.file).toEqual({ imports: ["./tree-import"] });
    expect(b.dangerOverlay?.file).toEqual({ imports: ["./b"] });
    expect(c.dangerOverlay).toBeUndefined();
  });

  it("claims the chunk floor when the tree's rows hydrated a step", async () => {
    const result = await makeOps(treeView()).tracePath({ collection: "c", from: "A", to: "C" });

    expect(result.workingTree?.floors).toEqual(["chunks"]);
  });

  it("falls back to the graph's range — never the index's payload — when no chunk layer can read the tree", async () => {
    const result = await makeOps(treeView(null)).tracePath({
      collection: "c",
      from: "A",
      to: "C",
      rerank: "hotspots",
    });

    expect(stepsOf(result)[0]).toEqual({ symbolId: "A", startLine: 10, endLine: 12 });
    expect(result.paths[0].steps[0].dangerOverlay).toBeUndefined();
    expect(result.workingTree?.floors).toEqual([]);
  });
});
