/**
 * ExploreOps tree-graph handle lease seams (bd tea-rags-mcp-4qdj0, iteration
 * 3) — find_symbol registers its request's tree-graph reader for leasing and
 * releases it when the request settles, so the request's decoration reads
 * (batch prefetch's ancestors+visibility pair, the single path's ancestors and
 * visibility passes) share ONE open READ_ONLY handle on the tree graph file,
 * and NOTHING stays open after the answer — the open-reader count
 * `ReadOnlyGraphFileReaders` tracks must drop to zero, or a superseded graph
 * can never be deleted (WTO-7, D5).
 *
 * Both seams are driven through the production path: the resolver deps are
 * bound to a real GraphFacade over a counting pool, exactly as
 * `createSymbolVisibilityResolver` / `createContainerAncestorResolver` bind
 * them in `src/bootstrap/factory.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { WorkingTreeGraphState, WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

vi.mock("../../../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

const PATH = "src/svc.ts";
const BUILT: WorkingTreeGraphState = {
  kind: "built",
  dbPath: "/tree.duckdb",
  physicalCollectionName: "code_x_v1",
} as never;

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 0,
  floors: [],
};

const member = (symbolId: string, startLine: number) => ({
  id: `id-${symbolId}`,
  payload: {
    symbolId,
    name: symbolId.split("#")[1],
    chunkType: "function",
    relativePath: PATH,
    content: `${symbolId} body`,
    startLine,
    endLine: startLine + 2,
    parentSymbolId: "Svc",
    parentType: "class_declaration",
  },
});
const CLASS_CHUNK = {
  id: "id-Svc",
  payload: {
    symbolId: "Svc",
    name: "Svc",
    chunkType: "class",
    relativePath: PATH,
    content: "class Svc {}",
    startLine: 1,
    endLine: 40,
  },
};
const OUTLINE = [CLASS_CHUNK, member("Svc#run", 5), member("Svc#helper", 10)];

function makeQdrant(results: unknown[]) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue(results),
    queryGroups: vi.fn().mockResolvedValue(results),
    hybridSearch: vi.fn().mockResolvedValue(results),
    query: vi.fn().mockResolvedValue(results),
    scrollFiltered: vi.fn().mockResolvedValue(results),
    scrollBySymbolIds: vi.fn().mockResolvedValue([]),
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

function makeRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, raw?: any) => raw),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

/** A pool whose FILE-READER opens and closes are counted — the lease observed from outside. */
function countingPool() {
  const opens: string[] = [];
  const closes: string[] = [];
  const graphDb = {
    close: vi.fn(async () => {
      closes.push("tree");
    }),
    getSupertypes: vi.fn(async () => []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) =>
      ids.map((symbolId) => ({ relPath: PATH, symbolId, visibility: "public" as const })),
    ),
    findSymbolChunk: vi.fn(async () => null),
  };
  const pool = {
    acquireFileReader: vi.fn(async (dbPath: string) => {
      opens.push(dbPath);
      return { graphDb, symbolTable: {} };
    }),
    acquireReader: vi.fn().mockResolvedValue({ graphDb, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
  return { pool, opens, closes };
}

function leasedView() {
  const view: WorkingTreeView = {
    marker: { ...MARKER },
    touchedPaths: new Set([PATH]),
    deletedPaths: new Set(),
    readTreeGraph: vi.fn(async () => BUILT),
  };
  return { view: vi.fn().mockResolvedValue(view) };
}

describe("ExploreOps tree-graph lease seams (bd tea-rags-mcp-4qdj0)", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "explore-lease-registry-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const makeFacade = (results: unknown[], qdrant = makeQdrant(results), overlay = leasedView()) => {
    const { pool, opens, closes } = countingPool();
    const graphFacade = new GraphFacade({ pool, collectionRegistry: {} as CollectionRegistry });
    const facade = new ExploreFacade({
      qdrant,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeRegistry(),
      collectionRegistry,
      payloadSignals: [],
      essentialKeys: [],
      workingTreeOverlay: overlay,
      // Factory-style bindings (createSymbolVisibilityResolver / createContainerAncestorResolver):
      // the decoration resolvers read through the REAL facade, so the request's
      // tree reads go through readWorkingTreeGraph with the recording reader.
      visibilityResolver: {
        resolveSymbolVisibilities: async (c: string, ids: readonly string[], readTreeGraph?: unknown) =>
          (graphFacade as any).getSymbolVisibilities({ collection: c }, ids, readTreeGraph),
      },
      containerAncestorResolver: {
        resolveContainerAncestors: async (c: string, ids: readonly string[], readTreeGraph?: unknown) =>
          (graphFacade as any).getContainerAncestors({ collection: c }, ids, readTreeGraph),
      },
    });
    return { facade, opens, closes };
  };

  it("a symbols[] batch leases ONE tree-graph handle for the whole request and releases it", async () => {
    const { facade, opens, closes } = makeFacade(OUTLINE);

    const response = await facade.findSymbol({ collection: "code_x", symbols: ["Svc#run", "Svc#helper"] });

    // The prefetch alone fires both resolvers (ancestors + visibility) over the
    // tree graph; the drill's per-address decorations fire more. One handle.
    expect(opens).toEqual(["/tree.duckdb"]);
    expect(closes).toEqual(["tree"]); // released at the seam — nothing left open
    expect(response.results.length + (response.missing?.length ?? 0)).toBeGreaterThan(0);
  });

  it("the single-symbol path leases ONE handle for its ancestors+visibility passes and releases it", async () => {
    const { facade, opens, closes } = makeFacade(OUTLINE);

    const response = await facade.findSymbol({ collection: "code_x", symbol: "Svc" });

    expect(opens).toEqual(["/tree.duckdb"]);
    expect(closes).toEqual(["tree"]);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("releases the lease when the drill throws after the prefetch opened the handle", async () => {
    // The prefetch rides the lease (opens the handle); the drill's scroll then
    // throws — the seam's finally must still release what the lease holds.
    const failing = makeQdrant(OUTLINE);
    failing.scrollFiltered = vi.fn().mockRejectedValue(new Error("boom"));
    const { facade, opens, closes } = makeFacade(OUTLINE, failing);

    await expect(facade.findSymbol({ collection: "code_x", symbols: ["Svc#run", "Svc#helper"] })).rejects.toThrow(
      "boom",
    );

    expect(opens).toEqual(["/tree.duckdb"]); // the prefetch's two reads, one handle
    expect(closes).toEqual(["tree"]); // released on the error path — nothing left open
  });
});
