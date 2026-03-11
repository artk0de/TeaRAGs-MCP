// src/bootstrap/config.test.ts — parseAppConfig bridge tests
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Helper: dynamic import with cache-busting to get fresh module state per test
async function freshImport() {
  vi.resetModules();
  return await import("../../src/bootstrap/config/index.js");
}

describe("parseAppConfig (Zod bridge)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear env vars that affect config to get deterministic defaults
    const keysToDelete = [
      "QDRANT_URL",
      "QDRANT_API_KEY",
      "EMBEDDING_PROVIDER",
      "SERVER_TRANSPORT",
      "TRANSPORT_MODE",
      "SERVER_HTTP_PORT",
      "HTTP_PORT",
      "SERVER_HTTP_TIMEOUT_MS",
      "HTTP_REQUEST_TIMEOUT_MS",
      "SERVER_PROMPTS_FILE",
      "PROMPTS_CONFIG_FILE",
      "INGEST_CHUNK_SIZE",
      "CODE_CHUNK_SIZE",
      "INGEST_CHUNK_OVERLAP",
      "CODE_CHUNK_OVERLAP",
      "INGEST_ENABLE_AST",
      "CODE_ENABLE_AST",
      "QDRANT_TUNE_UPSERT_BATCH_SIZE",
      "QDRANT_UPSERT_BATCH_SIZE",
      "CODE_BATCH_SIZE",
      "INGEST_DEFAULT_SEARCH_LIMIT",
      "CODE_SEARCH_LIMIT",
      "INGEST_ENABLE_HYBRID",
      "CODE_ENABLE_HYBRID",
      "TRAJECTORY_GIT_ENABLED",
      "CODE_ENABLE_GIT_METADATA",
      "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS",
      "TRAJECTORY_GIT_SESSION_GAP_MINUTES",
      "OPENAI_API_KEY",
      "COHERE_API_KEY",
      "VOYAGE_API_KEY",
    ];
    for (const key of keysToDelete) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return defaults when no env vars set", async () => {
    const { parseAppConfig } = await freshImport();
    const config = parseAppConfig();

    expect(config.qdrantUrl).toBeUndefined();
    expect(config.embeddingProvider).toBe("ollama");
    expect(config.transportMode).toBe("stdio");
    expect(config.httpPort).toBe(3000);
    expect(config.requestTimeoutMs).toBe(300000);
    expect(config.ingestCode.chunkSize).toBe(2500);
    expect(config.ingestCode.chunkOverlap).toBe(300);
    expect(config.exploreCode.defaultSearchLimit).toBe(5);
    expect(config.ingestCode.enableHybridSearch).toBe(false);
    expect(config.trajectoryIngest.enableGitMetadata).toBe(false);
    expect(config.trajectoryIngest.squashAwareSessions).toBe(false);
    expect(config.trajectoryIngest.sessionGapMinutes).toBe(30);
  });

  it("should parse env vars when set (via deprecated names)", async () => {
    process.env.QDRANT_URL = "http://custom:6333";
    process.env.QDRANT_API_KEY = "secret";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.TRANSPORT_MODE = "http";
    process.env.HTTP_PORT = "8080";
    process.env.CODE_CHUNK_SIZE = "5000";
    process.env.CODE_ENABLE_GIT_METADATA = "true";
    process.env.CODE_ENABLE_HYBRID = "true";

    const { parseAppConfig } = await freshImport();
    const config = parseAppConfig();

    expect(config.qdrantUrl).toBe("http://custom:6333");
    expect(config.qdrantApiKey).toBe("secret");
    expect(config.embeddingProvider).toBe("openai");
    expect(config.transportMode).toBe("http");
    expect(config.httpPort).toBe(8080);
    expect(config.ingestCode.chunkSize).toBe(5000);
    expect(config.trajectoryIngest.enableGitMetadata).toBe(true);
    expect(config.ingestCode.enableHybridSearch).toBe(true);
  });

  it("should collect deprecation notices for old env var names", async () => {
    process.env.TRANSPORT_MODE = "stdio";

    const { parseAppConfig, getZodConfig } = await freshImport();
    parseAppConfig();

    const { deprecations } = getZodConfig();
    expect(deprecations.length).toBeGreaterThan(0);
    expect(deprecations.some((d: { oldName: string }) => d.oldName === "TRANSPORT_MODE")).toBe(true);
  });

  it("should throw for invalid transport mode via Zod", async () => {
    process.env.SERVER_TRANSPORT = "grpc";
    const { parseAppConfig } = await freshImport();

    expect(() => parseAppConfig()).toThrow(/transport/i);
  });

  it("should throw for unknown embedding provider via Zod", async () => {
    process.env.EMBEDDING_PROVIDER = "unknown";
    const { parseAppConfig } = await freshImport();

    expect(() => parseAppConfig()).toThrow(/provider/i);
  });

  it("should throw when non-ollama provider has no API key", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const { parseAppConfig } = await freshImport();

    expect(() => parseAppConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it("should not throw when non-ollama provider has API key", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const { parseAppConfig } = await freshImport();

    expect(() => parseAppConfig()).not.toThrow();
  });

  it("bridges supportedExtensions and ignorePatterns from defaults", async () => {
    const { parseAppConfig } = await freshImport();
    const config = parseAppConfig();

    expect(config.ingestCode.supportedExtensions).toBeDefined();
    expect(config.ingestCode.supportedExtensions.length).toBeGreaterThan(0);
    expect(config.ingestCode.ignorePatterns).toBeDefined();
    expect(config.ingestCode.ignorePatterns.length).toBeGreaterThan(0);
  });
});
