/**
 * find_symbol's codegraph hop on a working tree (bd tea-rags-mcp-xi2r9, live
 * P2-1). A qualified name only the codegraph resolves — `AlphaService.run`,
 * collapsed into its class chunk — used to come back EMPTY once the tree
 * touched its file: the hop answered with the index's covering chunk, and the
 * chunk floor dropped it as stale. The hop now re-resolves against the tree:
 * the covering chunk's symbol is matched among the file's delta rows, and the
 * lookup itself reads the tree graph when the view has one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { SymbolChunkResolver } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeGraphState } from "../../../../../src/core/contracts/types/working-tree.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const ALPHA = "src/alpha.ts";
const BASE_CLASS = codeRow("base-alpha", {
  symbolId: "AlphaService",
  relativePath: ALPHA,
  chunkType: "class",
  content: "index body",
});
const TREE_CLASS = codeRow("tree-alpha", {
  symbolId: "AlphaService",
  relativePath: ALPHA,
  chunkType: "class",
  content: "tree body",
});

describe("SymbolSearchStrategy codegraph hop on a working tree (P2-1)", () => {
  const qdrant = {
    // No chunk carries `AlphaService.run` as its own symbolId or parent.
    scrollFiltered: vi.fn(async () => []),
    getPoint: vi.fn(async (_c: string, id: string | number) =>
      id === BASE_CLASS.id ? { id, payload: BASE_CLASS.payload } : null,
    ),
  } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  const resolver = {
    resolveSymbolChunk: vi.fn<SymbolChunkResolver["resolveSymbolChunk"]>(async () => ({
      relPath: ALPHA,
      chunkId: String(BASE_CLASS.id),
    })),
  };

  const find = async (view?: WorkingTreeView) =>
    new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol: "AlphaService.run" }, resolver).execute({
      collectionName: "c",
      limit: 50,
      ...(view ? { workingTreeView: view } : {}),
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers with the index's covering chunk when the tree did not touch its file", async () => {
    const results = await find(fakeWorkingTreeView({ changed: ["src/other.ts"], rows: [] }));

    expect(results.map((r) => r.id)).toEqual(["base-alpha"]);
  });

  it("answers with the tree's version of the covering chunk when the tree changed its file", async () => {
    const results = await find(fakeWorkingTreeView({ changed: [ALPHA], rows: [TREE_CLASS] }));

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("tree-alpha");
    expect(results[0].payload?.content).toBe("tree body");
  });

  it("answers with every split part of the tree's covering chunk", async () => {
    const parts = [1, 2].map((n) =>
      codeRow(`tree-alpha-${n}`, {
        symbolId: `AlphaService#part${n}`,
        parentSymbolId: "AlphaService",
        relativePath: ALPHA,
        content: `part ${n}`,
      }),
    );

    const results = await find(fakeWorkingTreeView({ changed: [ALPHA], rows: parts }));

    expect(results.map((r) => r.id)).toEqual(["tree-alpha-1", "tree-alpha-2"]);
  });

  it("answers nothing — never the index's stale chunk — when the tree no longer has the covering symbol", async () => {
    const other = codeRow("tree-beta", { symbolId: "BetaService", relativePath: ALPHA });

    const results = await find(fakeWorkingTreeView({ changed: [ALPHA], rows: [other] }));

    expect(results).toEqual([]);
  });

  it("answers nothing for a covering chunk of a file the tree deleted", async () => {
    const results = await find(fakeWorkingTreeView({ deleted: [ALPHA], rows: [] }));

    expect(results).toEqual([]);
  });

  it("hands the lookup the view's tree graph and records the graph it read on the marker", async () => {
    const built: WorkingTreeGraphState = {
      kind: "built",
      dbPath: "/graphs/tree.duckdb",
      physicalCollectionName: "c_v1" as never,
    };
    const view = fakeWorkingTreeView({ changed: [ALPHA], rows: [TREE_CLASS] });
    view.readTreeGraph = vi.fn(async () => built);
    resolver.resolveSymbolChunk.mockImplementationOnce(async (_c, _s, readTreeGraph) => {
      await readTreeGraph?.(120_000);
      return { relPath: ALPHA, chunkId: String(BASE_CLASS.id) };
    });

    const results = await find(view);

    expect(results.map((r) => r.id)).toEqual(["tree-alpha"]);
    expect(resolver.resolveSymbolChunk).toHaveBeenCalledWith("c", "AlphaService.run", expect.any(Function));
    expect(view.marker.floors).toContain("codegraph");
  });
});
