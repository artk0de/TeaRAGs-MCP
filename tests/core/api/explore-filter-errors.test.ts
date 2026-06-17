/**
 * End-to-end typed error propagation for filter preset resolution.
 *
 * Verifies that UnknownFilterPresetError and EmptyFilterPresetError thrown
 * inside resolveFilterSpec (ExploreOps.buildFilter → resolveFilterSpec) are
 * NOT swallowed by any try/catch in ExploreOps or ExploreFacade, and reach
 * the caller as typed ExploreError subclasses with httpStatus 400.
 *
 * Tested via ExploreFacade.semanticSearch — the full delegation chain:
 *   facade.semanticSearch → ExploreOps.embedAndDispatch → ExploreOps.buildFilter
 *   → resolveFilterSpec → UnknownFilterPresetError / EmptyFilterPresetError
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";
import {
  EmptyFilterPresetError,
  UnknownFilterPresetError,
} from "../../../src/core/domains/explore/errors.js";
import type { FilterPresetDef } from "../../../src/core/contracts/types/filter-preset.js";

// ---------------------------------------------------------------------------
// Module mocks (mirrors explore-facade-filter.test.ts harness)
// ---------------------------------------------------------------------------

vi.mock("../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit || 5,
    fetchLimit: (limit || 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) => results),
}));

vi.mock("../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  BM25SparseVectorGenerator: {
    generateSimple: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  },
}));

vi.mock("../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    constructor(_reranker: any, _descriptors: any) {}
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

// ---------------------------------------------------------------------------
// Stub filter preset definitions
// ---------------------------------------------------------------------------

const knownPresetDef: FilterPresetDef = {
  name: "production",
  description: "exclude test files",
  conditions: [{ signal: "isTest", op: "eq", value: true, occur: "must_not" }],
};

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    ensurePayloadIndex: vi.fn(),
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  } as any;
}

function makeMockReranker() {
  return {
    rerank: vi.fn((results: any[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([]),
  } as any;
}

/**
 * Registry mock with getFilterPresetDef — required for resolveFilterSpec
 * in ExploreOps.buildFilter. Registry.buildMergedFilter delegates to this
 * lookup before merging typed filter params.
 */
function makeMockRegistry(defs: FilterPresetDef[] = []) {
  const map = new Map(defs.map((d) => [d.name, d]));
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getFilterPresetDef: vi.fn((name: string) => map.get(name)),
  } as any;
}

function makeFacade(defs: FilterPresetDef[] = []) {
  return new ExploreFacade({
    qdrant: makeMockQdrant(),
    embeddings: makeMockEmbeddings(),
    reranker: makeMockReranker(),
    registry: makeMockRegistry(defs),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("end-to-end filter preset error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates UnknownFilterPresetError for an unregistered preset name", async () => {
    const facade = makeFacade(); // no defs registered → any name is unknown

    await expect(
      facade.semanticSearch({
        collection: "test-col",
        query: "some query",
        filter: { presets: "nope" },
      }),
    ).rejects.toBeInstanceOf(UnknownFilterPresetError);
  });

  it("UnknownFilterPresetError carries httpStatus 400", async () => {
    const facade = makeFacade();

    await expect(
      facade.semanticSearch({
        collection: "test-col",
        query: "some query",
        filter: { presets: "nope" },
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("propagates EmptyFilterPresetError when presets CSV has no resolvable names", async () => {
    const facade = makeFacade();

    await expect(
      facade.semanticSearch({
        collection: "test-col",
        query: "some query",
        filter: { presets: " , " },
      }),
    ).rejects.toBeInstanceOf(EmptyFilterPresetError);
  });

  it("EmptyFilterPresetError carries httpStatus 400", async () => {
    const facade = makeFacade();

    await expect(
      facade.semanticSearch({
        collection: "test-col",
        query: "some query",
        filter: { presets: "" },
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("both error types are NOT plain Error — they are ExploreError subclasses", async () => {
    const facade = makeFacade();

    const unknownErr = await facade
      .semanticSearch({ collection: "test-col", query: "q", filter: { presets: "nope" } })
      .catch((e: unknown) => e);

    const emptyErr = await facade
      .semanticSearch({ collection: "test-col", query: "q", filter: { presets: " , " } })
      .catch((e: unknown) => e);

    // Both must be instances of the typed error classes (not plain Error)
    expect(unknownErr).toBeInstanceOf(UnknownFilterPresetError);
    expect(emptyErr).toBeInstanceOf(EmptyFilterPresetError);

    // Both must be distinct from plain Error
    expect(unknownErr?.constructor?.name).toBe("UnknownFilterPresetError");
    expect(emptyErr?.constructor?.name).toBe("EmptyFilterPresetError");
  });

  it("does NOT throw when a valid registered preset is provided (control case)", async () => {
    const facade = makeFacade([knownPresetDef]); // "production" is known

    await expect(
      facade.semanticSearch({
        collection: "test-col",
        query: "some query",
        filter: { presets: "production" },
      }),
    ).resolves.toBeDefined();
  });
});
