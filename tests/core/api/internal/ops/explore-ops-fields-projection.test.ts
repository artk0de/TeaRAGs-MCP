/**
 * ExploreOps — the `fields` payload projection (bd tea-rags-mcp-l2lix).
 *
 * `fields` is applied in the ops finalize step, right after internal fields are
 * stripped, so every payload-bearing search tool gets it from one place rather
 * than each strategy growing its own copy. These cases pin that the param
 * reaches the response for each tool, and that an unmatched path is reported
 * instead of quietly producing empty payloads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";

// ---------------------------------------------------------------------------
// Module mocks — mirror explore-ops-confidence.test.ts exactly.
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
// Fixture — the fat payload the bead measured, trimmed to the same shape
// ---------------------------------------------------------------------------

const HITS = [
  {
    id: "p1",
    score: 0.7,
    payload: {
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      language: "typescript",
      fileExtension: ".ts",
      isTest: true,
      chunkType: "function",
      startLine: 1,
      endLine: 120,
      members: ["EnvSnapshot#restore"],
      git: { file: { commitCount: 12, ageDays: 40 }, chunk: { commitCount: 3 } },
      codegraph: { symbols: { file: { skippedAs: null } } },
    },
  },
];

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue(HITS),
    scrollOrdered: vi.fn().mockResolvedValue(HITS.map((h) => ({ id: h.id, payload: h.payload }))),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue(HITS),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue(HITS),
    query: vi.fn().mockResolvedValue(HITS),
    scrollAll: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0.1, 0.2, 0.3] }]),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;
}

function makeMockReranker() {
  return {
    hasCollectionStats: false,
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    // rank_chunks resolves order_by from preset weights → derived-signal
    // sources → payload key, so the harness declares one of each or the
    // scroll leg pools nothing and the tool returns [].
    getPreset: vi.fn().mockReturnValue({ churn: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([
      {
        name: "churn",
        description: "commit volume",
        sources: ["file.commitCount"],
        extract: () => 0.5,
      },
    ]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getFilterPresetDef: vi.fn().mockReturnValue(undefined),
  } as any;
}

function makeOps() {
  return new ExploreOps({
    qdrant: makeMockQdrant(),
    embeddings: makeMockEmbeddings(),
    reranker: makeMockReranker(),
    registry: makeMockRegistry(),
    collectionRegistry: {
      findByName: vi.fn().mockReturnValue(null),
      findByPath: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
    } as any,
    payloadSignals: [{ key: "git.file.commitCount", type: "number", description: "commits touching the file" }],
    essentialKeys: [],
  });
}

const COLLECTION = "code_test_col";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreOps — fields projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("semanticSearch returns only the requested payload paths", async () => {
    const response = await makeOps().semanticSearch({
      collection: COLLECTION,
      query: "env snapshot",
      fields: ["git.file.commitCount"],
    });

    expect(response.results[0]?.payload).toEqual({ git: { file: { commitCount: 12 } } });
    expect(response.fieldsWarning).toBeUndefined();
  });

  it("hybridSearch returns only the requested payload paths", async () => {
    const response = await makeOps().hybridSearch({
      collection: COLLECTION,
      query: "env snapshot",
      fields: ["relativePath", "git.file.commitCount"],
    });

    expect(response.results[0]?.payload).toEqual({
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      git: { file: { commitCount: 12 } },
    });
  });

  it("rankChunks returns only the requested payload paths", async () => {
    // metaOnly: false — the mocked filterMetaOnly above flattens results into
    // { score, relativePath } with no payload at all, which would test the
    // stub rather than the projection. rank_chunks defaults metaOnly true.
    const response = await makeOps().rankChunks({
      collection: COLLECTION,
      rerank: "hotspots",
      metaOnly: false,
      fields: ["git.chunk.commitCount"],
    });

    expect(response.results[0]?.payload).toEqual({ git: { chunk: { commitCount: 3 } } });
  });

  it("findSimilar returns only the requested payload paths", async () => {
    const ops = makeOps();
    const request = { collection: COLLECTION, positiveCode: ["const a = 1;"], fields: ["relativePath"] };

    const response = await ops.findSimilar(request, ops.buildSimilarStrategy(request));

    expect(response.results[0]?.payload).toEqual({ relativePath: "tests/bootstrap/env-snapshot.test.ts" });
  });

  it("findSymbol returns only the requested payload paths", async () => {
    const response = await makeOps().findSymbol({
      collection: COLLECTION,
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      fields: ["relativePath"],
    });

    expect(response.results.length).toBeGreaterThan(0);
    for (const result of response.results) {
      expect(Object.keys(result.payload ?? {})).toEqual(["relativePath"]);
    }
  });

  it("leaves the payload whole when no fields were asked for", async () => {
    const response = await makeOps().semanticSearch({ collection: COLLECTION, query: "env snapshot" });

    expect(response.results[0]?.payload).toHaveProperty("members");
    expect(response.results[0]?.payload).toHaveProperty("git");
    expect(response.fieldsWarning).toBeUndefined();
  });

  it("reports a misspelled path instead of returning empty payloads in silence", async () => {
    const response = await makeOps().semanticSearch({
      collection: COLLECTION,
      query: "env snapshot",
      fields: ["git.commitCount"],
    });

    expect(response.results[0]?.payload).toEqual({});
    expect(response.fieldsWarning).toContain("git.commitCount");
    expect(response.fieldsWarning).toContain("git.file.commitCount");
  });
});
