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

    const driftReporter = {
      checkAndConsume: vi.fn().mockResolvedValue(null),
      checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
      checkByCollectionName: vi.fn().mockReturnValue(null),
      reset: vi.fn(),
    };

    const projectRegistryOps = {
      register: vi.fn().mockResolvedValue({ collectionName: "x", alreadyIndexed: false }),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      unregister: vi.fn().mockResolvedValue({ removed: true }),
    };

    return { explore, ingest, qdrant, embeddings, reranker, driftReporter, projectRegistryOps };
  }

  it("delegates semanticSearch to explore facade", async () => {
    const { explore, ...rest } = makeDeps();
    const app = createApp({ explore, ...rest } as never);
    await app.semanticSearch({ query: "test", path: "/x" });
    expect(explore.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it("delegates getIndexStatus to ingest facade", async () => {
    const { ingest, ...rest } = makeDeps();
    const app = createApp({ ingest, ...rest } as never);
    await app.getIndexStatus("/repo");
    expect(ingest.getIndexStatus).toHaveBeenCalledWith("/repo");
  });

  // Live D10 (bd tea-rags-mcp-xi2r9): a linked worktree has no index of its own
  // — it is read against its base index, so its status is that index's.
  it("answers getIndexStatus of a working tree with its base index's status and the tree's marker", async () => {
    const deps = makeDeps();
    const marker = {
      tree: "/repo-feature",
      indexedCommit: null,
      treeCommit: null,
      indexedDirty: false,
      changedFiles: 1,
      deletedFiles: 0,
      floors: [],
    };
    deps.ingest.getIndexStatus.mockResolvedValue({ isIndexed: true, status: "indexed", collectionName: "code_repo" });
    const workingTreeIndexOf = vi.fn(async (path: string) =>
      path === "/repo-feature" ? { indexPath: "/repo", workingTree: marker } : undefined,
    );
    const app = createApp({ ...deps, workingTreeIndexOf } as never);

    const status = await app.getIndexStatus("/repo-feature");

    expect(deps.ingest.getIndexStatus).toHaveBeenCalledWith("/repo");
    expect(status).toMatchObject({ status: "indexed", indexPath: "/repo", workingTree: marker });
    await app.getIndexStatus("/repo");
    expect(deps.ingest.getIndexStatus).toHaveBeenLastCalledWith("/repo");
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

  it("awaits ingest for whenEnrichmentComplete", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.whenEnrichmentComplete();
    expect(deps.ingest.whenEnrichmentComplete).toHaveBeenCalledTimes(1);
  });

  it("codegraph methods return empty results when no graph backend is wired", async () => {
    // makeDeps() supplies neither graphFacade nor tracePathOps, so the App's
    // fallback branch must surface empties rather than crash the MCP tool.
    const deps = makeDeps();
    const app = createApp(deps as never);
    await expect(app.getCallees({ symbolId: "X" })).resolves.toEqual({ callees: [] });
    await expect(app.findCycles({ scope: "file" } as never)).resolves.toEqual({ cycles: [] });
  });

  it("checkIndexDrift routes a path to checkAndConsume", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.checkIndexDrift({ path: "/repo", consume: true });
    expect(deps.driftReporter.checkAndConsume).toHaveBeenCalledWith("/repo");
  });

  it("checkIndexDrift routes a collection to checkByCollectionName", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.checkIndexDrift({ collection: "code_abc", consume: false });
    expect(deps.driftReporter.checkByCollectionName).toHaveBeenCalledWith("code_abc");
  });

  it("checkIndexDrift routes a CONSUMING collection to the consuming collection check", async () => {
    // `consume` is the caller's declaration of what it is, and a collection is
    // no more an inspection than a path is: the search path addresses its
    // collection directly, so `consume: true` has to reach the consuming
    // variant or the warning it renders is never marked as shown.
    const deps = makeDeps();
    const app = createApp(deps as never);
    await app.checkIndexDrift({ collection: "code_abc", consume: true });
    expect(deps.driftReporter.checkAndConsumeByCollectionName).toHaveBeenCalledWith("code_abc");
    expect(deps.driftReporter.checkByCollectionName).not.toHaveBeenCalled();
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

  // bd tea-rags-mcp-94hd9
  it("getArchitectureReport delegates to the graph facade", async () => {
    const deps = makeDeps();
    const report = { summary: {}, rootCauses: [], violations: [] };
    const graphFacade = { getArchitectureReport: vi.fn().mockResolvedValue(report) };
    const app = createApp({ ...deps, graphFacade } as never);

    await expect(app.getArchitectureReport({ project: "p", pathPattern: "src/**" })).resolves.toBe(report);
    expect(graphFacade.getArchitectureReport).toHaveBeenCalledWith({ project: "p", pathPattern: "src/**" });
  });

  it("getArchitectureReport returns a report with nothing read when no graph backend is wired", async () => {
    const app = createApp(makeDeps() as never);

    const report = await app.getArchitectureReport({ project: "p" });

    expect(report.violations).toEqual([]);
    expect(report.summary.stableDependencies.edgeCount).toBe(0);
  });

  // bd tea-rags-mcp-4p3sb.20
  it("getOntologyReport delegates to OntologyReportOps", async () => {
    const report = { scope: { pathPrefix: "" }, summary: { evidenceRows: 3, genericNameCount: 0, genericNames: [] } };
    const ontologyReportOps = { report: vi.fn().mockResolvedValue(report) };
    const app = createApp({ ...makeDeps(), ontologyReportOps } as never);

    await expect(app.getOntologyReport({ project: "p", sections: ["homonyms"] })).resolves.toBe(report);
    expect(ontologyReportOps.report).toHaveBeenCalledWith({ project: "p", sections: ["homonyms"] });
  });

  it("getOntologyReport returns the empty report when codegraph is not wired", async () => {
    const app = createApp(makeDeps() as never);

    const report = await app.getOntologyReport({ project: "p", sections: ["synonyms"] });

    expect(report).toEqual({
      scope: { pathPrefix: "" },
      summary: { evidenceRows: 0, genericNameCount: 0, genericNames: [] },
      synonyms: [],
    });
  });

  // -------------------------------------------------------------------------
  // Per-project ingest scope. An MCP server is long-lived with a fixed process
  // env, so a project's registry env can only reach an index run through a
  // per-request facade — the CLI's "replay into the forked worker" trick has no
  // counterpart here.
  // -------------------------------------------------------------------------

  it("routes indexCodebase to the ingest facade resolved for the target path", async () => {
    const deps = makeDeps();
    const projectScoped = { indexCodebase: vi.fn().mockResolvedValue({ indexedCount: 0 }) };
    const ingestForPath = vi.fn().mockReturnValue(projectScoped);
    const app = createApp({ ...deps, ingestForPath } as never);

    await app.indexCodebase("/repo/alpha", { forceReindex: false });

    expect(ingestForPath).toHaveBeenCalledWith("/repo/alpha");
    expect(projectScoped.indexCodebase).toHaveBeenCalledTimes(1);
    expect(deps.ingest.indexCodebase).not.toHaveBeenCalled();
  });

  it("falls back to the process-wide ingest facade when no per-path resolver is wired", async () => {
    const deps = makeDeps();
    const app = createApp(deps as never);

    await app.indexCodebase("/repo/alpha", { forceReindex: false });

    expect(deps.ingest.indexCodebase).toHaveBeenCalledTimes(1);
  });
});
