import { describe, expect, it, vi } from "vitest";

import { createApp, type App } from "../../../../src/core/api/public/app.js";

describe("App interface — project registry methods", () => {
  it("declares registerProject, listProjects, unregisterProject", () => {
    const stub: Pick<App, "registerProject" | "listProjects" | "unregisterProject"> = {
      registerProject: async () => ({
        collectionName: "x",
        alreadyIndexed: false,
      }),
      listProjects: async () => ({ projects: [] }),
      unregisterProject: async () => ({ removed: false }),
    };
    expect(typeof stub.registerProject).toBe("function");
    expect(typeof stub.listProjects).toBe("function");
    expect(typeof stub.unregisterProject).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createApp — wiring correctness (façade + ops delegation)
// ---------------------------------------------------------------------------
describe("createApp", () => {
  function makeDeps() {
    const explore = {
      semanticSearch: vi.fn().mockResolvedValue({ results: [] }),
      hybridSearch: vi.fn().mockResolvedValue({ results: [] }),
      rankChunks: vi.fn().mockResolvedValue({ results: [] }),
      searchCode: vi.fn().mockResolvedValue({ results: [] }),
      findSimilar: vi.fn().mockResolvedValue({ results: [] }),
      findSymbol: vi.fn().mockResolvedValue({ results: [] }),
      getIndexMetrics: vi.fn().mockResolvedValue({}),
    };

    const ingest = {
      indexCodebase: vi.fn().mockResolvedValue({ indexedCount: 0 }),
      whenEnrichmentComplete: vi.fn().mockResolvedValue(undefined),
      reindexChanges: vi.fn().mockResolvedValue({ added: 0 }),
      getIndexStatus: vi.fn().mockResolvedValue({ isIndexed: false, status: "not_indexed" }),
      clearIndex: vi.fn().mockResolvedValue(undefined),
    };

    const qdrant = {
      url: "http://localhost:6333",
      collectionExists: vi.fn().mockResolvedValue(false),
      createCollection: vi.fn().mockResolvedValue(undefined),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      listCollections: vi.fn().mockResolvedValue([]),
      getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 0 }),
      upsert: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      scroll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      aliases: {
        createAlias: vi.fn(),
        deleteAlias: vi.fn(),
        listAliases: vi.fn().mockResolvedValue([]),
        isAlias: vi.fn().mockResolvedValue(false),
      },
      getPoint: vi.fn().mockResolvedValue(null),
    };

    const embeddings = {
      embed: vi.fn().mockResolvedValue({ embedding: [], dimensions: 384 }),
      embedBatch: vi.fn().mockResolvedValue([]),
      getDimensions: vi.fn().mockReturnValue(384),
      getModel: vi.fn().mockReturnValue("test-model"),
      checkHealth: vi.fn().mockResolvedValue(true),
      getProviderName: vi.fn().mockReturnValue("mock"),
    };

    const reranker = {
      getDescriptorInfo: vi.fn().mockReturnValue([]),
      getPresetNames: vi.fn().mockReturnValue([]),
      getPresetDetails: vi.fn().mockReturnValue([]),
      getPayloadSignals: vi.fn().mockReturnValue([]),
    };

    const schemaDriftMonitor = {
      checkAndConsume: vi.fn().mockResolvedValue(null),
      checkByCollectionName: vi.fn().mockResolvedValue(null),
    };

    const projectRegistryOps = {
      register: vi.fn().mockResolvedValue({ collectionName: "x", alreadyIndexed: false }),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      unregister: vi.fn().mockResolvedValue({ removed: true }),
    };

    return { explore, ingest, qdrant, embeddings, reranker, schemaDriftMonitor, projectRegistryOps };
  }

  it("delegates semanticSearch to explore facade", async () => {
    const { explore, ...rest } = makeDeps();
    const app = createApp({ explore, ...rest } as never);
    await app.semanticSearch({ query: "test", path: "/x" } as never);
    expect(explore.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it("delegates getIndexStatus to ingest facade", async () => {
    const { ingest, ...rest } = makeDeps();
    const app = createApp({ ingest, ...rest } as never);
    await app.getIndexStatus("/repo");
    expect(ingest.getIndexStatus).toHaveBeenCalledWith("/repo");
  });

  it("getSchemaDescriptors calls reranker descriptor methods and returns preset/signal info", () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    const result = app.getSchemaDescriptors();
    expect(deps.reranker.getDescriptorInfo).toHaveBeenCalled();
    expect(deps.reranker.getPresetNames).toHaveBeenCalled();
    expect(result).toHaveProperty("presetNames");
    expect(result).toHaveProperty("signalDescriptors");
  });

  it("checkSchemaDrift routes path ref to checkAndConsume", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.checkSchemaDrift({ path: "/repo" });
    expect(deps.schemaDriftMonitor.checkAndConsume).toHaveBeenCalledWith("/repo");
  });

  it("checkSchemaDrift routes collection ref to checkByCollectionName", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.checkSchemaDrift({ collection: "code_abc" });
    expect(deps.schemaDriftMonitor.checkByCollectionName).toHaveBeenCalledWith("code_abc");
  });

  it("hasProvider returns false when registeredProviderKeys is absent", () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    expect(app.hasProvider("git")).toBe(false);
  });

  it("hasProvider returns true when key is in registeredProviderKeys", () => {
    const deps = makeDeps();
    const app = createApp({ ...deps, registeredProviderKeys: new Set(["git"]) } as never);
    expect(app.hasProvider("git")).toBe(true);
    expect(app.hasProvider("static")).toBe(false);
  });

  it("getCallers returns empty array when graphFacade is absent", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    const result = await app.getCallers({ symbol: "foo" } as never);
    expect(result).toEqual({ callers: [] });
  });
});
