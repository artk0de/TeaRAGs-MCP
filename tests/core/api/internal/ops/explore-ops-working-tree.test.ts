/**
 * ExploreOps — every read answer carries the `workingTree` marker
 * (bd tea-rags-mcp-xi2r9.1), on every return path: results, empty results,
 * `metaOnly`, `fields` projection. The drift check keeps reading the INDEX
 * root: a tree path must never be handed to the drift reporter, which would
 * resolve it to a path-hash collection nobody indexed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

vi.mock("../../../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

const HIT = { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "a", language: "typescript" } };

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 2,
  deletedFiles: 1,
  floors: [],
};

function makeQdrant(results: unknown[]) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue(results),
    queryGroups: vi.fn().mockResolvedValue(results),
    hybridSearch: vi.fn().mockResolvedValue(results),
    query: vi.fn().mockResolvedValue(results),
    scrollFiltered: vi.fn().mockResolvedValue(results),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    getPoint: vi.fn().mockResolvedValue(null),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeReranker() {
  return {
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeTrajectoryRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, raw?: any) => raw),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeDriftReporter() {
  return {
    checkAndConsume: vi.fn().mockResolvedValue(null),
    checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
  } as any;
}

function stubOverlay(marker: WorkingTreeMarker = MARKER) {
  const view: WorkingTreeView = { marker, touchedPaths: new Set(), deletedPaths: new Set() };
  return { view: vi.fn().mockResolvedValue(view) };
}

describe("ExploreOps workingTree marker", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "explore-wt-registry-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const makeFacade = (results: unknown[], overlay = stubOverlay()) =>
    new ExploreFacade({
      qdrant: makeQdrant(results),
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeTrajectoryRegistry(),
      collectionRegistry,
      driftReporter: makeDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
      workingTreeOverlay: overlay,
    });

  const tools = {
    semantic_search: async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      f.semanticSearch({ collection: "code_x", query: "q", ...extra }),
    hybrid_search: async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      f.hybridSearch({ collection: "code_x", query: "q", ...extra }),
    rank_chunks: async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      f.rankChunks({ collection: "code_x", rerank: "techDebt", ...extra }),
    find_similar: async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      f.findSimilar({ collection: "code_x", positiveIds: ["1"], ...extra }),
    find_symbol: async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      f.findSymbol({ collection: "code_x", relativePath: "src/a.ts", ...extra }),
  } as const;

  for (const [tool, call] of Object.entries(tools)) {
    it(`should attach the marker to a ${tool} answer with results`, async () => {
      const response = await call(makeFacade([HIT]));

      expect(response.workingTree).toEqual(MARKER);
    });

    it(`should attach the marker to an empty ${tool} answer`, async () => {
      const response = await call(makeFacade([]));

      expect(response.results).toEqual([]);
      expect(response.workingTree).toEqual(MARKER);
    });

    it(`should attach the marker to a metaOnly ${tool} answer`, async () => {
      const response = await call(makeFacade([HIT]), { metaOnly: true });

      expect(response.workingTree).toEqual(MARKER);
    });

    it(`should attach the marker to a fields-projected ${tool} answer`, async () => {
      const response = await call(makeFacade([HIT]), { fields: ["relativePath"] });

      expect(response.workingTree).toEqual(MARKER);
    });
  }

  it("should attach a degraded marker as it came from the overlay", async () => {
    const degraded = { ...MARKER, changedFiles: 0, deletedFiles: 0, degraded: { reason: "r", remedy: "m" } };

    const response = await makeFacade([HIT], stubOverlay(degraded)).semanticSearch({
      collection: "code_x",
      query: "q",
    });

    expect(response.workingTree).toEqual(degraded);
  });

  it("should hand the overlay the resolved tree and the caller's alias", async () => {
    const overlay = stubOverlay();

    await makeFacade([HIT], overlay).semanticSearch({ collection: "code_x", query: "q" });

    expect(overlay.view).toHaveBeenCalledWith(
      { root: "", baseIndex: { collectionName: "code_x", root: undefined } },
      undefined,
    );
  });
});

describe("ExploreOps working-tree floors (bd tea-rags-mcp-xi2r9.3)", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "explore-wt-floors-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  /** A view whose chunk layer reports one unparsed file once its rows are read. */
  const chunkedView = (rows: unknown[]): WorkingTreeView => {
    const view: WorkingTreeView = {
      marker: { ...MARKER, changedFiles: 2, deletedFiles: 0 },
      touchedPaths: new Set(["src/a.ts", "src/broken.ts"]),
      deletedPaths: new Set(),
    };
    view.readDeltaChunks = async () => {
      view.marker.unparsed = ["src/broken.ts"];
      return rows as never;
    };
    return view;
  };

  const makeFacade = (results: unknown[], view: WorkingTreeView) =>
    new ExploreFacade({
      qdrant: makeQdrant(results),
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeTrajectoryRegistry(),
      collectionRegistry,
      driftReporter: makeDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
      workingTreeOverlay: { view: vi.fn().mockResolvedValue(view) },
    });

  const TREE_ROW = {
    id: "t",
    payload: { relativePath: "src/a.ts", symbolId: "tree", content: "tree body", language: "typescript" },
  };

  it("should declare the chunks floor on find_symbol and carry what the chunk layer could not parse", async () => {
    const response = await makeFacade([HIT], chunkedView([TREE_ROW])).findSymbol({
      collection: "code_x",
      relativePath: "src/a.ts",
    });

    expect(response.workingTree?.floors).toEqual(["chunks"]);
    expect(response.workingTree?.unparsed).toEqual(["src/broken.ts"]);
    expect(String(response.results[0].payload?.content)).toContain("tree");
  });

  it("should declare no floor on semantic_search and carry treeState on its stale rows", async () => {
    const response = await makeFacade([HIT], chunkedView([TREE_ROW])).semanticSearch({
      collection: "code_x",
      query: "q",
    });

    expect(response.workingTree?.floors).toEqual([]);
    expect(response.results[0].treeState).toBe("modified");
  });

  it("should declare the chunks and sparse floors on hybrid_search and answer touched files from the tree (xi2r9.4)", async () => {
    const response = await makeFacade([HIT], chunkedView([TREE_ROW])).hybridSearch({
      collection: "code_x",
      query: "tree",
    });

    expect(response.workingTree?.floors).toEqual(["chunks", "sparse"]);
    expect(response.workingTree?.unparsed).toEqual(["src/broken.ts"]);
    expect(response.results.map((r) => r.id)).toContain("t");
    expect(response.results.every((r) => r.treeState === undefined)).toBe(true);
  });

  it("should declare no floor on find_symbol when no chunk layer is wired", async () => {
    const view: WorkingTreeView = { marker: MARKER, touchedPaths: new Set(["src/a.ts"]), deletedPaths: new Set() };

    const response = await makeFacade([HIT], view).findSymbol({ collection: "code_x", relativePath: "src/a.ts" });

    expect(response.workingTree?.floors).toEqual([]);
    expect(response.results[0].treeState).toBe("modified");
  });

  it("should keep the codegraph floor the delta rows recorded beside the strategy's floors (WTO-7)", async () => {
    const view = chunkedView([TREE_ROW]);
    const read = view.readDeltaChunks;
    view.readDeltaChunks = async () => {
      view.marker.floors = [...view.marker.floors, "codegraph"];
      return read ? read() : [];
    };

    const response = await makeFacade([HIT], view).hybridSearch({ collection: "code_x", query: "tree" });

    expect(response.workingTree?.floors).toEqual(["chunks", "sparse", "codegraph"]);
  });

  // Live D8 (bd tea-rags-mcp-xi2r9): a floor names a layer that supplied tree
  // data to THIS answer. Invariant changed: the operation no longer declares
  // its floors up front — a clean tree supplied nothing, so it claims nothing.
  describe("floors claimed only by tree data that reached the answer (D8)", () => {
    const BUILT_GRAPH = { kind: "built", dbPath: "/g.duckdb", physicalCollectionName: "code_x_v1" } as const;

    /** A measured, EMPTY delta with a chunk layer wired: nothing to substitute. */
    const cleanView = (): WorkingTreeView => {
      const view: WorkingTreeView = {
        marker: { ...MARKER, changedFiles: 0, deletedFiles: 0 },
        touchedPaths: new Set(),
        deletedPaths: new Set(),
      };
      view.readDeltaChunks = async () => [];
      return view;
    };

    /** Delta rows whose codegraph block came from the built tree graph. */
    const treeGraphView = (): WorkingTreeView => {
      const view = chunkedView([TREE_ROW]);
      const read = view.readDeltaChunks;
      view.readDeltaChunks = async () => {
        view.deltaRowsTreeGraph = BUILT_GRAPH as never;
        return read ? read() : [];
      };
      return view;
    };

    const calls = {
      find_symbol: async (f: ExploreFacade) => f.findSymbol({ collection: "code_x", symbol: "tree" }),
      find_symbol_outline: async (f: ExploreFacade) => f.findSymbol({ collection: "code_x", relativePath: "src/a.ts" }),
      hybrid_search: async (f: ExploreFacade) => f.hybridSearch({ collection: "code_x", query: "tree" }),
      semantic_search: async (f: ExploreFacade) => f.semanticSearch({ collection: "code_x", query: "tree" }),
      rank_chunks: async (f: ExploreFacade) => f.rankChunks({ collection: "code_x", rerank: "techDebt" }),
      find_similar: async (f: ExploreFacade) => f.findSimilar({ collection: "code_x", positiveIds: ["1"] }),
    } as const;

    for (const [tool, call] of Object.entries(calls)) {
      it(`should report no floor on a clean tree's ${tool} answer`, async () => {
        const response = await call(makeFacade([HIT], cleanView()));

        expect(response.workingTree?.floors).toEqual([]);
      });
    }

    it("should not claim codegraph on find_similar, which reads delta rows only for a tree positive's content", async () => {
      const response = await makeFacade([HIT], treeGraphView()).findSimilar({
        collection: "code_x",
        positiveIds: ["t"],
      });

      expect(response.workingTree?.floors).toEqual([]);
      expect(response.workingTree?.treeGraphUnavailable).toBeUndefined();
    });

    it("should claim codegraph beside the chunk floors when the enriched delta rows were candidates", async () => {
      const response = await makeFacade([HIT], treeGraphView()).hybridSearch({ collection: "code_x", query: "tree" });

      expect(response.workingTree?.floors).toEqual(["chunks", "sparse", "codegraph"]);
    });
  });
});

describe("ExploreOps drift check reads the INDEX root, never the tree", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;
  let tree: string;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    tree = fixture.addWorktree("feature");
    registryDir = mkdtempSync(join(tmpdir(), "explore-wt-drift-"));
    collectionRegistry = new CollectionRegistry(registryDir);
    collectionRegistry.record({
      collectionName: "code_main",
      path: fixture.mainRoot,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    });
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  const makeFacade = (driftReporter: ReturnType<typeof makeDriftReporter>, qdrant = makeQdrant([HIT])) =>
    new ExploreFacade({
      qdrant,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeTrajectoryRegistry(),
      collectionRegistry,
      driftReporter,
      payloadSignals: [],
      essentialKeys: [],
      workingTreeOverlay: stubOverlay(),
    });

  it("should check drift at the main checkout when path is a linked worktree", async () => {
    const driftReporter = makeDriftReporter();
    const qdrant = makeQdrant([HIT]);

    await makeFacade(driftReporter, qdrant).semanticSearch({ path: tree, query: "q" });

    expect(qdrant.collectionExists).toHaveBeenCalledWith("code_main");
    expect(driftReporter.checkAndConsume).toHaveBeenCalledWith(fixture.mainRoot);
    expect(driftReporter.checkAndConsume).not.toHaveBeenCalledWith(tree);
  });

  it("should check drift at the index root for a sub-read addressed by collection plus tree path", async () => {
    // naming-lexicon-ops `addressedRequest` shape: explicit collection, the tree as `path`.
    const driftReporter = makeDriftReporter();

    await makeFacade(driftReporter).findSymbol({ collection: "code_main", path: tree, symbol: "x" });

    expect(driftReporter.checkAndConsume).toHaveBeenCalledWith(fixture.mainRoot);
    expect(driftReporter.checkAndConsume).not.toHaveBeenCalledWith(tree);
  });

  // Live D10: a read tool handed a worktree path answers for its base index.
  describe("workingTreeIndexOf (D10)", () => {
    it("should name the base index a linked worktree is read against, with the tree's marker", async () => {
      const target = await makeFacade(makeDriftReporter()).workingTreeIndexOf(tree);

      expect(target?.indexPath).toBe(fixture.mainRoot);
      expect(target?.workingTree).toEqual(MARKER);
    });

    it("should name nothing for the index's own checkout", async () => {
      expect(await makeFacade(makeDriftReporter()).workingTreeIndexOf(fixture.mainRoot)).toBeUndefined();
    });

    it("should name nothing for a path no registered index covers", async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "explore-wt-unindexed-"));
      try {
        expect(await makeFacade(makeDriftReporter()).workingTreeIndexOf(elsewhere)).toBeUndefined();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });
});
