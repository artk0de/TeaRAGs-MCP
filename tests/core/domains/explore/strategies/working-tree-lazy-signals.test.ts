/**
 * Delta rows get their trajectory payload lazily (bd tea-rags-mcp-xi2r9, live
 * C1): the view's `readDeltaChunks` yields structure only, and a strategy asks
 * `signalDeltaRows` for the rows that reach ITS candidates — so an answer pays
 * git and codegraph for the files it returns, never for the whole delta. A
 * 159-file delta made the first cold `find_symbol` after a commit cost ~13 s:
 * every changed file was blamed although the answer held one.
 *
 * The payload of a returned row and what rerank reads are unchanged: the rows
 * that reach the answer carry the blocks the eager path gave them, and a
 * request filter that reads a trajectory key sees them before admission.
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const QUERY = [1, 0];
const withCosine = (c: number): number[] => [c, Math.sqrt(1 - c * c)];

const treeRows: ScrollChunk[] = FILES.map((path, i) =>
  codeRow(`t${String(i)}`, {
    relativePath: path,
    symbolId: `fn${"ABC"[i]}`,
    content: `export function fn${"ABC"[i]}() {}`,
  }),
);

const pathOf = (row: { payload?: Record<string, unknown> }): string => String(row.payload?.relativePath);

/** The git block the view's signal source gives a file's rows. */
const gitOf = (path: string) => ({ file: { commitCount: path === "src/a.ts" ? 9 : 1 } });

/** A view over the three-file delta whose `signalDeltaRows` is a spy recording which rows it was asked for. */
function lazyView(): { view: WorkingTreeView; signalled: () => string[] } {
  const view = fakeWorkingTreeView({
    changed: FILES,
    rows: treeRows,
    dense: {
      vectors: new Map([
        ["t0", withCosine(0.95)],
        ["t1", withCosine(0.1)],
        ["t2", withCosine(0.1)],
      ]),
      pending: 0,
    },
    basePoints: new Map(),
  });
  // As the overlay's: a row that is not one of the view's delta rows passes through.
  const isDeltaRow = (row: { id?: string | number }): boolean => treeRows.some((tree) => tree.id === row.id);
  const asked = new Set<string>();
  view.signalDeltaRows = async (rows) => {
    for (const row of rows) if (isDeltaRow(row)) asked.add(pathOf(row));
    return rows.map((row) => {
      if (!row.payload || !isDeltaRow(row)) return row;
      const signalled = { ...row };
      signalled.payload = { ...row.payload, git: gitOf(pathOf(row)) };
      return signalled;
    });
  };
  return { view, signalled: () => [...asked].sort() };
}

const reranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

describe("delta rows signalled lazily, per answer", () => {
  it("find_symbol asks signals for the file of the rows it answers, not the whole delta", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue([]) } as unknown as QdrantManager;
    const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as never;
    const { view, signalled } = lazyView();

    const results = await new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol: "fnA" }).execute({
      collectionName: "c",
      limit: 50,
      workingTreeView: view,
    });

    expect(results.map((r) => r.id)).toEqual(["t0"]);
    expect(results[0].payload?.git).toEqual(gitOf("src/a.ts"));
    expect(signalled()).toEqual(["src/a.ts"]);
  });

  describe("semantic_search", () => {
    /** Twenty base rows outscoring every tree row but the first: the page holds one tree file. */
    const base = Array.from({ length: 20 }, (_, i) => ({
      id: `b${String(i)}`,
      score: 0.9,
      payload: { relativePath: `src/base${String(i)}.ts`, language: "typescript" },
    }));
    const semantic = async (view: WorkingTreeView, filter?: Record<string, unknown>) => {
      const qdrant = {
        search: vi.fn(async () => base),
        getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, pointsCount: base.length }),
      } as unknown as QdrantManager;
      return new VectorSearchStrategy(qdrant, reranker, [], []).execute({
        collectionName: "c",
        embedding: QUERY,
        limit: 1,
        workingTreeView: view,
        ...(filter ? { filter } : {}),
      });
    };

    it("asks signals only for the tree rows that reach the candidate pool", async () => {
      const { view, signalled } = lazyView();

      const results = await semantic(view);

      expect(results.map((r) => r.id)).toEqual(["t0"]);
      expect(results[0].payload?.git).toEqual(gitOf("src/a.ts"));
      expect(signalled()).toEqual(["src/a.ts"]);
    });

    it("signals every row before admission when the request filter reads a trajectory key", async () => {
      const { view } = lazyView();

      const results = await semantic(view, { must: [{ key: "git.file.commitCount", range: { gte: 5 } }] });

      // Unsignalled, no tree row carries git.file.commitCount and the filter refuses all three.
      expect(results.map((r) => r.id)).toEqual(["t0"]);
    });

    it("records the tree graph the signalled rows' codegraph came from", async () => {
      const { view } = lazyView();
      const signal = view.signalDeltaRows;
      view.signalDeltaRows = async (rows) => {
        view.deltaRowsTreeGraph = { kind: "built", dbPath: "/g.duckdb", physicalCollectionName: "c_v1" as never };
        return signal ? signal(rows) : [...rows];
      };

      await semantic(view);

      expect(view.marker.floors).toEqual(["chunks", "dense", "codegraph"]);
    });
  });
});
