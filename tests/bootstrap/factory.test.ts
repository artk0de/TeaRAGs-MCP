// src/bootstrap/factory.test.ts
import * as nodeFs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts, wireCodegraph } from "../../src/bootstrap/factory.js";
import type { WorkerEnrichmentDescriptor } from "../../src/core/contracts/types/provider.js";
import type { GitTrajectory as GitTrajectoryType } from "../../src/core/domains/trajectory/git.js";
import { CollectionRegistry } from "../../src/core/infra/registry/index.js";
import { loadPromptsConfig } from "../../src/mcp/prompts/index.js";

// vi.hoisted: shared state for the GitTrajectory constructor spy (used in Test 1
// below). Must be declared before any vi.mock calls because vi.mock is hoisted
// to the top of the file by Vitest — the closure reference to `captured` must
// be in scope at that point.
const captured = vi.hoisted(() => ({ gitWorkerDescriptor: undefined as WorkerEnrichmentDescriptor | undefined }));

// Partial mock of the git trajectory module so the spy can record the
// workerDescriptor argument passed by wireComposition (bootstrap/factory.ts).
// The real class still runs — only the constructor argument is recorded.
vi.mock("../../src/core/domains/trajectory/git.js", async (importOriginal) => {
  const mod = await (importOriginal as () => Promise<{ GitTrajectory: typeof GitTrajectoryType }>)();
  const OrigGitTrajectory = mod.GitTrajectory;
  return {
    ...mod,
    GitTrajectory: class extends OrigGitTrajectory {
      constructor(
        config?: Parameters<typeof OrigGitTrajectory>[0],
        squashOpts?: Parameters<typeof OrigGitTrajectory>[1],
        workerDescriptor?: WorkerEnrichmentDescriptor,
      ) {
        super(config, squashOpts, workerDescriptor);
        captured.gitWorkerDescriptor = workerDescriptor;
      }
    },
  };
});

// Mock heavy dependencies — use function() (not =>) so `new` works
vi.mock("../../src/core/adapters/qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(function () {
    this.checkHealth = async () => Promise.resolve(true);
    this.url = "http://localhost:6333";
  }),
}));
vi.mock("../../src/core/adapters/embeddings/factory.js", () => ({
  EmbeddingProviderFactory: {
    create: vi.fn().mockReturnValue({
      getDimensions: () => 768,
      getModel: () => "test-model",
      checkHealth: async () => Promise.resolve(true),
      getProviderName: () => "mock",
    }),
  },
}));
vi.mock("../../src/core/api/internal/facades/ingest-facade.js", () => ({
  IngestFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/api/internal/facades/explore-facade.js", () => ({
  ExploreFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/domains/explore/reranker.js", () => ({
  Reranker: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/domains/explore/rerank/presets/index.js", () => ({
  resolvePresets: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/core/domains/trajectory/static/index.js", () => ({
  StaticTrajectory: vi.fn().mockImplementation(function () {
    this.key = "static";
    this.payloadSignals = [];
    this.derivedSignals = [];
    this.filters = [];
    this.presets = [];
  }),
}));
vi.mock("../../src/core/domains/trajectory/git/rerank/derived-signals/index.js", () => ({
  gitDerivedSignals: [],
}));
vi.mock("../../src/core/domains/trajectory/git/rerank/presets/index.js", () => ({
  GIT_PRESETS: [],
}));
vi.mock("../../src/mcp/tools/index.js", () => ({
  registerAllTools: vi.fn(),
}));
vi.mock("../../src/mcp/resources/index.js", () => ({
  registerAllResources: vi.fn(),
}));
vi.mock("../../src/mcp/prompts/register.js", () => ({
  registerAllPrompts: vi.fn(),
}));
vi.mock("../../src/mcp/prompts/index.js", () => ({
  loadPromptsConfig: vi.fn(),
}));
vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

// Mock getZodConfig to return a valid embedding config slice
vi.mock("../../src/bootstrap/config/index.js", async () => {
  const actual = await import("../../src/bootstrap/config/index.js");
  return {
    ...actual,
    getZodConfig: vi.fn().mockReturnValue({
      core: {
        debug: false,
        qdrantUrl: "http://localhost:6333",
        transportMode: "stdio",
        httpPort: 3000,
        requestTimeoutMs: 300000,
        promptsConfigFile: "/nonexistent/prompts.json",
      },
      embedding: {
        provider: "ollama",
        ollamaLegacyApi: false,
        ollamaNumGpu: 999,
        tune: {
          concurrency: 1,
          batchSize: 1024,
          batchTimeoutMs: 2000,
          retryAttempts: 3,
          retryDelayMs: 1000,
        },
      },
      ingest: {
        tune: {
          chunkerPoolSize: 4,
          fileConcurrency: 50,
          ioConcurrency: 50,
        },
      },
      trajectoryGit: {},
      qdrantTune: {
        deleteBatchSize: 500,
        deleteConcurrency: 8,
        deleteFlushTimeoutMs: 1000,
      },
      deprecations: [],
      flags: { userSetBatchSize: false },
    }),
  };
});

function makeConfig(): AppConfig {
  return {
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    transportMode: "stdio",
    httpPort: 3000,
    requestTimeoutMs: 300000,
    promptsConfigFile: "/nonexistent/prompts.json",
    ingestCode: {
      chunkSize: 2500,
      chunkOverlap: 300,
      supportedExtensions: [".ts"],
      ignorePatterns: [],
      enableHybridSearch: false,
    },
    exploreCode: {
      enableHybridSearch: false,
      defaultSearchLimit: 5,
    },
    trajectoryIngest: {},
    paths: {
      appData: "/tmp/test-tea-rags",
      snapshots: "/tmp/test-tea-rags/snapshots",
      logs: "/tmp/test-tea-rags/logs",
      models: "/tmp/test-tea-rags/models",
      daemonSocket: "/tmp/test-tea-rags/onnx.sock",
      daemonPid: "/tmp/test-tea-rags/onnx-daemon.pid",
    },
  };
}

describe("createAppContext", () => {
  it("should create app, schemaBuilder, and cleanup", async () => {
    const ctx = await createAppContext(makeConfig());
    expect(ctx.app).toBeDefined();
    expect(ctx.schemaBuilder).toBeDefined();
    expect(ctx.cleanup).toBeDefined();
  });

  it("wires CollectionRegistry.startWatching and stops it in cleanup (audit #2)", async () => {
    const stop = vi.fn();
    const startWatching = vi.spyOn(CollectionRegistry.prototype, "startWatching").mockReturnValue(stop);
    try {
      const ctx = await createAppContext(makeConfig());
      expect(startWatching).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      ctx.cleanup?.();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      startWatching.mockRestore();
    }
  });

  it("git runs inline (no workerDescriptor) so it uses the InlineEnrichmentExecutor in-process (production regression guard)", async () => {
    // This test is GENUINELY RED when bootstrap/factory.ts builds a gitWorkerDescriptor
    // and passes it to GitTrajectory. It reads the ACTUAL value captured by the
    // GitTrajectory constructor spy (declared at module scope above).
    //
    // Why inline matters (live taxdome evidence): collection-affinity pins git to
    // ONE worker, removing the 4-way parallelism. Per-batch cost is dominated by
    // walkCommits (git log + cat-file + structuredPatch), NOT blame — so blame
    // reuse gave no per-apply speedup. Worker-pool cross-thread dispatch
    // (postMessage serialization of chunkMap/results per batch) IS the overhead.
    // Inline (no workerDescriptor) → InlineEnrichmentExecutor calls
    // provider.buildFileSignals/buildChunkSignals directly in-process on the
    // single composition-root instance, so blame cache reuse is automatic and
    // there is zero postMessage overhead. This is origin/main behavior.
    captured.gitWorkerDescriptor = undefined;
    await createAppContext(makeConfig());
    expect(captured.gitWorkerDescriptor).toBeUndefined();
  });
});

describe("createConfiguredServer", () => {
  it("should return an MCP server instance", async () => {
    const ctx = await createAppContext(makeConfig());
    const server = createConfiguredServer(ctx, null);
    expect(server).toBeDefined();
    // Verify it has connect method (MCP server interface)
    expect(typeof server.connect).toBe("function");
  });
});

describe("loadPrompts", () => {
  it("returns null when prompts config file does not exist", () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const result = loadPrompts(makeConfig());
    expect(result).toBeNull();
  });

  it("returns parsed prompts config when file exists", () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    const fakeConfig = { prompts: [{ name: "test", description: "t", template: "t" }] };
    vi.mocked(loadPromptsConfig).mockReturnValue(fakeConfig as any);

    const result = loadPrompts(makeConfig());
    expect(result).toEqual(fakeConfig);
  });

  it("calls process.exit(1) when loadPromptsConfig throws", () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(loadPromptsConfig).mockImplementation(() => {
      throw new Error("parse error");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number) => {
      throw new Error("process.exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadPrompts(makeConfig())).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

describe("wireCodegraph", () => {
  // Minimal codegraph-enabled zodConfig slice. wireCodegraph reads only
  // `zodConfig.codegraph`; the rest of the config object is irrelevant to
  // pool construction so we cast the narrow shape.
  function zodConfigWithCodegraph(): ReturnType<typeof getZodConfig> {
    return {
      codegraph: {
        enabled: true,
        dbMemoryLimit: "2GB",
        dbThreads: 2,
        excludeTests: true,
        customExcludePatterns: [],
        ambiguousResolveMode: "strict",
      },
    } as unknown as ReturnType<typeof getZodConfig>;
  }

  it("always passes a daemonSocketPath into the pool (daemon is the default write path)", () => {
    // The daemon is base functionality — no opt-in env flag. Wiring always
    // points the pool at the daemon socket regardless of environment.
    const ctx = wireCodegraph(makeConfig(), zodConfigWithCodegraph());
    expect(ctx).toBeDefined();
    const socketPath = (ctx!.pool as unknown as { options: { daemonSocketPath?: string } }).options.daemonSocketPath;
    expect(socketPath).toMatch(/codegraph-daemon\.sock$/);
  });
});
