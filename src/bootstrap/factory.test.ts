// src/bootstrap/factory.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock heavy dependencies — use function() (not =>) so `new` works
vi.mock("../core/qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../core/embeddings/factory.js", () => ({
  EmbeddingProviderFactory: {
    createFromEnv: vi.fn().mockReturnValue({ getDimensions: () => 768 }),
  },
}));
vi.mock("../core/code/indexer.js", () => ({
  CodeIndexer: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../mcp/tools/index.js", () => ({
  registerAllTools: vi.fn(),
}));
vi.mock("../mcp/resources/index.js", () => ({
  registerAllResources: vi.fn(),
}));
vi.mock("../mcp/prompts/register.js", () => ({
  registerAllPrompts: vi.fn(),
}));

import type { AppConfig } from "./config.js";
import { createAppContext, createConfiguredServer } from "./factory.js";

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
  it("should create qdrant, embeddings, and codeIndexer", () => {
    const ctx = createAppContext(makeConfig());
    expect(ctx.qdrant).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.codeIndexer).toBeDefined();
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
