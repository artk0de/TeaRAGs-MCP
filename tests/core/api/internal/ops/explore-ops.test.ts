/**
 * ExploreOps — chunkResolver threading test.
 *
 * Verifies that when ExploreOps receives a `chunkResolver` in its deps,
 * that resolver is threaded into SymbolSearchStrategy so the
 * resolveViaCodegraph fallback path can fire when the primary Qdrant
 * scroll returns empty results.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

// ---------------------------------------------------------------------------
// Module mocks — mirror explore-ops-edges.test.ts exactly.
// ---------------------------------------------------------------------------

vi.mock("../../../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit ?? 5,
    fetchLimit: (limit ?? 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) =>
    results.map((r: any) => ({ score: r.score, relativePath: r.payload?.relativePath })),
  ),
}));

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1], values: [0.5] })),
  BM25SparseVectorGenerator: { generateSimple: vi.fn(() => ({ indices: [1], values: [0.5] })) },
}));

// ---------------------------------------------------------------------------
// Mock factories — spread+override pattern from explore-ops-edges.test.ts.
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue([]),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;
}

function makeMockReranker(overrides: Record<string, any> = {}) {
  return {
    hasCollectionStats: false,
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
    ...overrides,
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeMockCollectionRegistry() {
  return {
    findByName: vi.fn().mockReturnValue(null),
    findByPath: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreOps.findSymbol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes chunkResolver into SymbolSearchStrategy so resolveViaCodegraph fires on empty scroll", async () => {
    // Arrange: a mock chunkResolver (resolveSymbolChunk returns null — no
    // codegraph chunk found). scrollFiltered returns [] on both passes so
    // the primary + parent scroll produces nothing and the strategy falls
    // through to resolveViaCodegraph, which calls resolveSymbolChunk.
    const chunkResolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };

    const ops = new ExploreOps({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: makeMockRegistry(),
      collectionRegistry: makeMockCollectionRegistry(),
      payloadSignals: [],
      essentialKeys: [],
      chunkResolver,
    });

    // Act: findSymbol with collection (bypasses registry lookup) + a symbol
    // that has no Qdrant chunks (scroll → []) so the codegraph fallback runs.
    await ops.findSymbol({ symbol: "Foo#bar", collection: "code_test_col" });

    // Assert: the resolver was consulted with the collection name and the
    // exact symbol string the caller passed in.
    expect(chunkResolver.resolveSymbolChunk).toHaveBeenCalledWith(expect.any(String), "Foo#bar");
  });
});

/**
 * bd tea-rags-mcp-dxa9w re-review LOW-1 — every path-shaped surface hands the
 * owner the SAME spelling.
 *
 * `resolveCollection` tries the plain resolved spelling before canonicalizing,
 * which is what keeps an entry recorded by a pre-canonicalization writer (the
 * old worktree provisioner stored a bare `resolve`) findable. A caller that
 * canonicalizes first defeats that: the fast lookup misses, the slow one is
 * skipped because canonicalization changed nothing, and the call lands on a
 * hash — so the same legacy project answers with one collection through
 * `semantic_search` and another through `get_index_metrics`.
 */
describe("ExploreOps.getIndexMetrics", () => {
  let legacyRoot: string;

  afterEach(() => {
    if (legacyRoot) rmSync(legacyRoot, { recursive: true, force: true });
  });

  it("resolves a legacy non-canonical entry the same way the search legs do", async () => {
    // Symlink built explicitly so the case discriminates on Linux CI too, not
    // only where `tmpdir()` happens to be symlinked.
    legacyRoot = mkdtempSync(join(tmpdir(), "eo-legacy-"));
    const realParent = join(legacyRoot, "real");
    const linkedParent = join(legacyRoot, "linked");
    mkdirSync(join(realParent, "clone"), { recursive: true });
    symlinkSync(realParent, linkedParent);
    const nonCanonical = join(linkedParent, "clone");
    expect(realpathSync(nonCanonical)).not.toBe(nonCanonical);

    const collectionRegistry = new CollectionRegistry(legacyRoot);
    collectionRegistry.record({
      collectionName: "code_legacy01",
      path: nonCanonical,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    });
    // `statsCache` is what makes ExploreOps build its IndexMetricsQuery at all,
    // and `ensureStats` hands it the resolved collection — so the cache load is
    // the resolution, observed through constructor-time DI rather than by
    // swapping a private field.
    const statsCache = { load: vi.fn().mockReturnValue(null), save: vi.fn(), lastWrittenAt: vi.fn() };

    const ops = new ExploreOps({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: makeMockRegistry(),
      collectionRegistry,
      statsCache,
      payloadSignals: [],
      essentialKeys: [],
    } as never);

    // The metrics query itself runs against a mock Qdrant; whatever it returns
    // or throws is beside the point, which is the collection it was pointed at.
    await ops.getIndexMetrics(nonCanonical).catch(() => undefined);

    expect(statsCache.load).toHaveBeenCalledWith("code_legacy01");
  });
});
