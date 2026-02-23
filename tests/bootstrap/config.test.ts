// src/bootstrap/config.test.ts — merged from config/env.test.ts + config/validate.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppConfig, parseAppConfig, validateConfig } from "../../src/bootstrap/config.js";

// --- parseAppConfig tests (was config/env.test.ts) ---

describe("parseAppConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return defaults when no env vars set", () => {
    delete process.env.QDRANT_URL;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.TRANSPORT_MODE;
    delete process.env.HTTP_PORT;
    delete process.env.CODE_CHUNK_SIZE;
    delete process.env.CODE_CHUNK_OVERLAP;
    delete process.env.CODE_ENABLE_AST;
    delete process.env.CODE_BATCH_SIZE;
    delete process.env.QDRANT_UPSERT_BATCH_SIZE;
    delete process.env.CODE_SEARCH_LIMIT;
    delete process.env.CODE_ENABLE_HYBRID;
    delete process.env.CODE_ENABLE_GIT_METADATA;
    delete process.env.HTTP_REQUEST_TIMEOUT_MS;
    delete process.env.PROMPTS_CONFIG_FILE;

    const config = parseAppConfig();

    expect(config.qdrantUrl).toBe("http://localhost:6333");
    expect(config.embeddingProvider).toBe("ollama");
    expect(config.transportMode).toBe("stdio");
    expect(config.httpPort).toBe(3000);
    expect(config.requestTimeoutMs).toBe(300000);
    expect(config.code.chunkSize).toBe(2500);
    expect(config.code.chunkOverlap).toBe(300);
    expect(config.code.enableASTChunking).toBe(true);
    expect(config.code.batchSize).toBe(100);
    expect(config.code.defaultSearchLimit).toBe(5);
    expect(config.code.enableHybridSearch).toBe(false);
    expect(config.code.enableGitMetadata).toBe(false);
  });

  it("should parse env vars when set", () => {
    process.env.QDRANT_URL = "http://custom:6333";
    process.env.QDRANT_API_KEY = "secret";
    process.env.EMBEDDING_PROVIDER = "OpenAI";
    process.env.TRANSPORT_MODE = "HTTP";
    process.env.HTTP_PORT = "8080";
    process.env.CODE_CHUNK_SIZE = "5000";
    process.env.CODE_ENABLE_GIT_METADATA = "true";
    process.env.CODE_ENABLE_HYBRID = "true";

    const config = parseAppConfig();

    expect(config.qdrantUrl).toBe("http://custom:6333");
    expect(config.qdrantApiKey).toBe("secret");
    expect(config.embeddingProvider).toBe("openai");
    expect(config.transportMode).toBe("http");
    expect(config.httpPort).toBe(8080);
    expect(config.code.chunkSize).toBe(5000);
    expect(config.code.enableGitMetadata).toBe(true);
    expect(config.code.enableHybridSearch).toBe(true);
  });
});

// --- validateConfig tests (was config/validate.test.ts) ---

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    transportMode: "stdio",
    httpPort: 3000,
    requestTimeoutMs: 300000,
    promptsConfigFile: "/tmp/prompts.json",
    code: {
      chunkSize: 2500,
      chunkOverlap: 300,
      enableASTChunking: true,
      supportedExtensions: [".ts"],
      ignorePatterns: ["node_modules/**"],
      batchSize: 100,
      defaultSearchLimit: 5,
      enableHybridSearch: false,
      enableGitMetadata: false,
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should pass for valid stdio config", () => {
    expect(() => validateConfig(makeConfig())).not.toThrow();
  });

  it("should pass for valid http config", () => {
    expect(() => validateConfig(makeConfig({ transportMode: "http" }))).not.toThrow();
  });

  it("should throw for invalid transport mode", () => {
    expect(() => validateConfig(makeConfig({ transportMode: "grpc" as any }))).toThrow(/transport/i);
  });

  it("should throw for invalid HTTP port in http mode", () => {
    expect(() => validateConfig(makeConfig({ transportMode: "http", httpPort: 0 }))).toThrow(/port/i);
    expect(() => validateConfig(makeConfig({ transportMode: "http", httpPort: 70000 }))).toThrow(/port/i);
    expect(() => validateConfig(makeConfig({ transportMode: "http", httpPort: NaN }))).toThrow(/port/i);
  });

  it("should not validate port for stdio mode", () => {
    expect(() => validateConfig(makeConfig({ transportMode: "stdio", httpPort: 0 }))).not.toThrow();
  });

  it("should throw for invalid requestTimeoutMs in http mode", () => {
    expect(() => validateConfig(makeConfig({ transportMode: "http", requestTimeoutMs: -1 }))).toThrow(/timeout/i);
    expect(() => validateConfig(makeConfig({ transportMode: "http", requestTimeoutMs: NaN }))).toThrow(/timeout/i);
  });

  it("should throw for unknown embedding provider", () => {
    expect(() => validateConfig(makeConfig({ embeddingProvider: "unknown" }))).toThrow(/provider/i);
  });

  it("should accept all known providers", () => {
    for (const provider of ["ollama", "openai", "cohere", "voyage"]) {
      // Set API keys for non-ollama providers
      process.env.OPENAI_API_KEY = "test";
      process.env.COHERE_API_KEY = "test";
      process.env.VOYAGE_API_KEY = "test";
      expect(() => validateConfig(makeConfig({ embeddingProvider: provider }))).not.toThrow();
    }
  });

  it("should throw when non-ollama provider has no API key in env", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => validateConfig(makeConfig({ embeddingProvider: "openai" }))).toThrow(/OPENAI_API_KEY/);
  });
});
