// src/bootstrap/factory.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock heavy dependencies — use function() (not =>) so `new` works
vi.mock("../../src/core/adapters/qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/adapters/embeddings/factory.js", () => ({
  EmbeddingProviderFactory: {
    createFromEnv: vi.fn().mockReturnValue({ getDimensions: () => 768 }),
  },
}));
vi.mock("../../src/core/api/ingest-facade.js", () => ({
  IngestFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/api/search-facade.js", () => ({
  SearchFacade: vi.fn().mockImplementation(function () {}),
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

import type { AppConfig } from "../../src/bootstrap/config.js";
import { createAppContext, createConfiguredServer } from "../../src/bootstrap/factory.js";

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
  it("should create qdrant, embeddings, ingest, and search facades", () => {
    const ctx = createAppContext(makeConfig());
    expect(ctx.qdrant).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.ingest).toBeDefined();
    expect(ctx.search).toBeDefined();
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
