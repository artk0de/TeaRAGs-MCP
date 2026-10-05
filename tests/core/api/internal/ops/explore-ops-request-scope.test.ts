/**
 * ExploreOps — the searches one caller request runs share an
 * {@link ExploreRequestScope} (bd tea-rags-mcp-89k7k.1.18): the index
 * existence probe and the working-tree measurement are read once per request,
 * never once per search. Without a scope every search reads both, as before.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import { ExploreRequestScope } from "../../../../../src/core/domains/explore/request-scope.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

vi.mock("../../../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
};

function makeQdrant(exists: () => Promise<boolean>) {
  return {
    collectionExists: vi.fn(exists),
    search: vi.fn().mockResolvedValue([]),
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

function stubOverlay() {
  const view: WorkingTreeView = { marker: MARKER, touchedPaths: new Set(), deletedPaths: new Set() };
  return { view: vi.fn().mockResolvedValue(view) };
}

describe("ExploreOps — request-scoped reads", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "explore-scope-registry-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const makeFacade = (qdrant = makeQdrant(async () => true), overlay = stubOverlay()) => ({
    qdrant,
    overlay,
    facade: new ExploreFacade({
      qdrant,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeTrajectoryRegistry(),
      collectionRegistry,
      driftReporter: {
        checkAndConsume: vi.fn().mockResolvedValue(null),
        checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
      } as any,
      payloadSignals: [],
      essentialKeys: [],
      workingTreeOverlay: overlay,
    }),
  });

  it("should probe the index once for every search of one request", async () => {
    const { facade, qdrant } = makeFacade();
    const scope = new ExploreRequestScope();

    await Promise.all([
      facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "a" }),
      facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "b" }),
    ]);
    await facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "c" });

    expect(qdrant.collectionExists).toHaveBeenCalledTimes(1);
  });

  it("should hand every search's view the request's working-tree measurements", async () => {
    const { facade, overlay } = makeFacade();
    const scope = new ExploreRequestScope();

    await facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "a" });
    await facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "b" });

    expect(overlay.view).toHaveBeenCalledTimes(2);
    for (const call of overlay.view.mock.calls) expect(call[2]).toBe(scope.workingTree);
  });

  it("should probe again after a failed probe instead of replaying the failure", async () => {
    let calls = 0;
    const { facade, qdrant } = makeFacade(
      makeQdrant(async () => {
        calls++;
        if (calls === 1) throw new Error("qdrant down");
        return true;
      }),
    );
    const scope = new ExploreRequestScope();

    await expect(facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "a" })).rejects.toThrow(
      "qdrant down",
    );
    await facade.withRequestScope(scope).semanticSearch({ collection: "code_x", query: "b" });

    expect(qdrant.collectionExists).toHaveBeenCalledTimes(2);
  });

  it("should probe the index and measure the tree per search without a scope", async () => {
    const { facade, qdrant, overlay } = makeFacade();

    await facade.semanticSearch({ collection: "code_x", query: "a" });
    await facade.semanticSearch({ collection: "code_x", query: "b" });

    expect(qdrant.collectionExists).toHaveBeenCalledTimes(2);
    for (const call of overlay.view.mock.calls) expect(call[2]).toBeUndefined();
  });
});
