/**
 * find_symbol for a symbol the working tree DEFINES but no chunk names as its
 * own (live D1, bd tea-rags-mcp-xi2r9): a short method collapsed into its class
 * chunk, in a file the tree added or changed. The tree graph knows where the
 * symbol is defined, but it carries no chunk id for a delta file — chunk ids
 * are the index's — so the codegraph hop used to fall to its last-segment tier
 * and answer `Cat#speak` with the BASE `Animal` chunk, or answer
 * `Holder#movedMethod` with nothing. The tree's definition is now answered
 * from the tree's own rows: the delta row of the defining file that covers the
 * definition's lines.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type {
  PersistedSymbolLineRanges,
  SymbolChunkResolver,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeGraphState } from "../../../../../src/core/contracts/types/working-tree.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const ANIMAL = "src/zoo/animal.ts";
const CAT = "src/zoo/cat.ts";
const MOVER = "src/core/mover.ts";

const BASE_ANIMAL = codeRow("base-animal", {
  symbolId: "Animal",
  chunkType: "class",
  relativePath: ANIMAL,
  startLine: 1,
  endLine: 5,
  content: "export class Animal { speak() {} }",
});
const TREE_CAT = codeRow("tree-cat", {
  symbolId: "Cat",
  chunkType: "class",
  relativePath: CAT,
  startLine: 3,
  endLine: 7,
  content: "export class Cat extends Animal { speak() { return 'meow'; } }",
});
const TREE_MOVER = codeRow("tree-mover", {
  symbolId: "Mover",
  chunkType: "class",
  relativePath: MOVER,
  startLine: 1,
  endLine: 5,
  content: "export class Mover { stays() {} }",
});
const TREE_HOLDER = codeRow("tree-holder", {
  symbolId: "Holder",
  chunkType: "class",
  relativePath: MOVER,
  startLine: 7,
  endLine: 15,
  content: "export class Holder { hold() {} movedMethod() {} }",
});

const BUILT: WorkingTreeGraphState = {
  kind: "built",
  dbPath: "/g/tree.duckdb",
  physicalCollectionName: "c_v1" as never,
};

/** The tree graph's symbol ranges of the changed files, as `getSymbolLineRangesBulk` reads them. */
const TREE_RANGES = new Map<string, PersistedSymbolLineRanges>([
  [
    CAT,
    {
      rowsWithoutRanges: 0,
      ranges: [
        { symbolId: "Cat", startLine: 3, endLine: 7 },
        { symbolId: "Cat#speak", startLine: 4, endLine: 6 },
      ],
    },
  ],
  [
    MOVER,
    {
      rowsWithoutRanges: 0,
      ranges: [
        { symbolId: "Mover", startLine: 1, endLine: 5 },
        { symbolId: "Mover#stays", startLine: 2, endLine: 4 },
        { symbolId: "Holder", startLine: 7, endLine: 15 },
        { symbolId: "Holder#hold", startLine: 8, endLine: 10 },
        { symbolId: "Holder#movedMethod", startLine: 12, endLine: 14 },
      ],
    },
  ],
]);

describe("SymbolSearchStrategy — symbols the working tree defines (D1)", () => {
  const qdrant = {
    // No chunk carries the queried member as its own symbolId or parent.
    scrollFiltered: vi.fn(async () => []),
    getPoint: vi.fn(async (_c: string, id: string | number) =>
      id === BASE_ANIMAL.id ? { id, payload: BASE_ANIMAL.payload } : null,
    ),
  } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  let resolver: {
    resolveSymbolChunk: ReturnType<typeof vi.fn<SymbolChunkResolver["resolveSymbolChunk"]>>;
    readTreeSymbolLineRanges?: ReturnType<typeof vi.fn<NonNullable<SymbolChunkResolver["readTreeSymbolLineRanges"]>>>;
  };

  /** The tree of the live probe: cat.ts untracked, mover.ts changed (movedMethod moved Mover → Holder). */
  const treeView = (rows: ScrollChunk[] = [TREE_CAT, TREE_MOVER, TREE_HOLDER]): WorkingTreeView => {
    const view = fakeWorkingTreeView({ changed: [CAT, MOVER], rows });
    view.readTreeGraph = vi.fn(async () => BUILT);
    return view;
  };

  const find = async (symbol: string, view: WorkingTreeView, ctx: Record<string, unknown> = {}) =>
    new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol }, resolver).execute({
      collectionName: "c",
      limit: 50,
      workingTreeView: view,
      ...ctx,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = {
      // The tree graph has no chunk id for a delta file's symbol, so its
      // last-segment tier answers `…#speak` with the base Animal chunk.
      resolveSymbolChunk: vi.fn(async (_c, symbolId) =>
        symbolId.endsWith("speak") ? { relPath: ANIMAL, chunkId: String(BASE_ANIMAL.id) } : null,
      ),
      readTreeSymbolLineRanges: vi.fn(async (_c, relPaths, readTreeGraph) => {
        const state = await readTreeGraph(120_000);
        if (state.kind !== "built") return null;
        return new Map([...TREE_RANGES].filter(([path]) => relPaths.includes(path)));
      }),
    };
  });

  it("answers a member of a tree-only class with the tree's covering row, never a base row of another class", async () => {
    const results = await find("Cat#speak", treeView());

    expect(results.map((r) => r.id)).toEqual(["tree-cat"]);
    expect(results[0].payload?.content).toContain("meow");
  });

  it("answers a method moved to another class in a changed file under its new owner", async () => {
    const results = await find("Holder#movedMethod", treeView());

    expect(results.map((r) => r.id)).toEqual(["tree-holder"]);
  });

  it("answers the bare name of a moved method with its new owner's row", async () => {
    const results = await find("movedMethod", treeView());

    expect(results.map((r) => r.id)).toEqual(["tree-holder"]);
  });

  it("does not answer an instance method addressed with the static separator", async () => {
    resolver.resolveSymbolChunk.mockResolvedValue(null);

    const results = await find("Holder.movedMethod", treeView());

    expect(results).toEqual([]);
  });

  it("does not answer the moved method under its old owner", async () => {
    resolver.resolveSymbolChunk.mockResolvedValue(null);

    const results = await find("Mover#movedMethod", treeView());

    expect(results).toEqual([]);
  });

  it("claims the chunk floor and the tree graph it read on the marker", async () => {
    const view = treeView();

    await find("Cat#speak", view);

    expect(view.marker.floors).toEqual(["chunks", "codegraph"]);
  });

  it("strips the row's content on metaOnly", async () => {
    const results = await find("Cat#speak", treeView(), { metaOnly: true });

    expect(results.map((r) => r.id)).toEqual(["tree-cat"]);
    expect(results[0].payload?.content).toBeUndefined();
  });

  it("answers a codegraph chunk id that names a delta row from that row, without asking Qdrant", async () => {
    delete resolver.readTreeSymbolLineRanges;
    resolver.resolveSymbolChunk.mockResolvedValue({ relPath: CAT, chunkId: String(TREE_CAT.id) });

    const results = await find("Cat#speak", treeView());

    expect(results.map((r) => r.id)).toEqual(["tree-cat"]);
    expect(qdrant.getPoint).not.toHaveBeenCalled();
  });

  it("falls back to the index hop when the tree graph is not built", async () => {
    const view = treeView();
    view.readTreeGraph = vi.fn(async () => ({ kind: "unavailable" as const, reason: "building" }));

    const results = await find("Animal#speak", view);

    expect(results.map((r) => r.id)).toEqual(["base-animal"]);
    expect(view.marker.treeGraphUnavailable).toBe("building");
  });
});
