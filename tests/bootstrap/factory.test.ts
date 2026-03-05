// src/bootstrap/factory.test.ts
import * as nodeFs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/bootstrap/config.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "../../src/bootstrap/factory.js";
import { loadPromptsConfig } from "../../src/mcp/prompts/index.js";

// Mock heavy dependencies — use function() (not =>) so `new` works
vi.mock("../../src/core/adapters/qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/adapters/embeddings/factory.js", () => ({
  EmbeddingProviderFactory: {
    create: vi.fn().mockReturnValue({ getDimensions: () => 768 }),
  },
}));
vi.mock("../../src/core/api/ingest-facade.js", () => ({
  IngestFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/api/search-facade.js", () => ({
  SearchFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/search/reranker.js", () => ({
  Reranker: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/search/rerank/derived-signals/index.js", () => ({
  structuralSignals: [],
}));
vi.mock("../../src/core/search/rerank/presets/index.js", () => ({
  RELEVANCE_PRESETS: [],
  resolvePresets: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/core/trajectory/git/rerank/derived-signals/index.js", () => ({
  gitDerivedSignals: [],
}));
vi.mock("../../src/core/trajectory/git/rerank/presets/index.js", () => ({
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
vi.mock("../../src/bootstrap/config.js", async () => {
  const actual = await import("../../src/bootstrap/config.js");
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
    code: {
      chunkSize: 2500,
      chunkOverlap: 300,
      enableASTChunking: true,
      supportedExtensions: [".ts"],
      ignorePatterns: [],
      batchSize: 100,
      defaultSearchLimit: 5,
      enableHybridSearch: false,
    },
  };
}

describe("createAppContext", () => {
  it("should create qdrant, embeddings, ingest, search, and reranker", () => {
    const ctx = createAppContext(makeConfig());
    expect(ctx.qdrant).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.ingest).toBeDefined();
    expect(ctx.search).toBeDefined();
    expect(ctx.reranker).toBeDefined();
  });
});

describe("createConfiguredServer", () => {
  it("should return an MCP server instance", () => {
    const ctx = createAppContext(makeConfig());
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
