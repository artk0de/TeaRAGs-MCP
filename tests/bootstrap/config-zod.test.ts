import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Helper: dynamic import with cache-busting to get fresh module state per test
async function freshImport() {
  vi.resetModules();
  return await import("../../src/bootstrap/config/index.js");
}

describe("parseAppConfigZod", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all env vars that affect config
    const keysToDelete = [
      "DEBUG",
      "QDRANT_URL",
      "QDRANT_API_KEY",
      "SERVER_TRANSPORT",
      "TRANSPORT_MODE",
      "SERVER_HTTP_PORT",
      "HTTP_PORT",
      "SERVER_HTTP_TIMEOUT_MS",
      "HTTP_REQUEST_TIMEOUT_MS",
      "SERVER_PROMPTS_FILE",
      "PROMPTS_CONFIG_FILE",
      "EMBEDDING_PROVIDER",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIMENSIONS",
      "EMBEDDING_BASE_URL",
      "OLLAMA_LEGACY_API",
      "OLLAMA_NUM_GPU",
      "OPENAI_API_KEY",
      "COHERE_API_KEY",
      "VOYAGE_API_KEY",
      "EMBEDDING_TUNE_BATCH_SIZE",
      "EMBEDDING_BATCH_SIZE",
      "CODE_BATCH_SIZE",
      "EMBEDDING_TUNE_MIN_BATCH_SIZE",
      "MIN_BATCH_SIZE",
      "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
      "BATCH_FORMATION_TIMEOUT_MS",
      "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
      "EMBEDDING_MAX_REQUESTS_PER_MINUTE",
      "EMBEDDING_TUNE_RETRY_ATTEMPTS",
      "EMBEDDING_RETRY_ATTEMPTS",
      "EMBEDDING_TUNE_RETRY_DELAY_MS",
      "EMBEDDING_RETRY_DELAY",
      // ingest
      "INGEST_CHUNK_SIZE",
      "CODE_CHUNK_SIZE",
      "INGEST_CHUNK_OVERLAP",
      "CODE_CHUNK_OVERLAP",
      "INGEST_ENABLE_AST",
      "CODE_ENABLE_AST",
      "INGEST_ENABLE_HYBRID",
      "CODE_ENABLE_HYBRID",
      "INGEST_DEFAULT_SEARCH_LIMIT",
      "CODE_SEARCH_LIMIT",
      "INGEST_PIPELINE_CONCURRENCY",
      "EMBEDDING_TUNE_CONCURRENCY",
      "EMBEDDING_CONCURRENCY",
      "INGEST_TUNE_CHUNKER_POOL_SIZE",
      "CHUNKER_POOL_SIZE",
      "INGEST_TUNE_FILE_CONCURRENCY",
      "FILE_PROCESSING_CONCURRENCY",
      "INGEST_TUNE_IO_CONCURRENCY",
      "MAX_IO_CONCURRENCY",
      // trajectoryGit
      "TRAJECTORY_GIT_ENABLED",
      "CODE_ENABLE_GIT_METADATA",
      "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
      "GIT_LOG_MAX_AGE_MONTHS",
      "TRAJECTORY_GIT_LOG_TIMEOUT_MS",
      "GIT_LOG_TIMEOUT_MS",
      "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
      "GIT_CHUNK_CONCURRENCY",
      "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS",
      "GIT_CHUNK_MAX_AGE_MONTHS",
      "TRAJECTORY_GIT_CHUNK_TIMEOUT_MS",
      "GIT_CHUNK_TIMEOUT_MS",
      "TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES",
      "GIT_CHUNK_MAX_FILE_LINES",
      "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS",
      "TRAJECTORY_GIT_SESSION_GAP_MINUTES",
      // qdrantTune
      "QDRANT_TUNE_UPSERT_BATCH_SIZE",
      "QDRANT_UPSERT_BATCH_SIZE",
      "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
      "QDRANT_FLUSH_INTERVAL_MS",
      "QDRANT_TUNE_UPSERT_ORDERING",
      "QDRANT_BATCH_ORDERING",
      "QDRANT_TUNE_DELETE_BATCH_SIZE",
      "QDRANT_DELETE_BATCH_SIZE",
      "DELETE_BATCH_SIZE",
      "QDRANT_TUNE_DELETE_CONCURRENCY",
      "QDRANT_DELETE_CONCURRENCY",
      "DELETE_CONCURRENCY",
      "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
      "DELETE_FLUSH_TIMEOUT_MS",
    ];
    for (const key of keysToDelete) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("core defaults", () => {
    it("returns correct defaults when no env vars set", async () => {
      const { parseAppConfigZod } = await freshImport();
      const { core } = parseAppConfigZod();

      expect(core.debug).toBe(false);
      expect(core.qdrantUrl).toBeUndefined();
      expect(core.qdrantApiKey).toBeUndefined();
      expect(core.transportMode).toBe("stdio");
      expect(core.httpPort).toBe(3000);
      expect(core.requestTimeoutMs).toBe(300000);
      expect(core.promptsConfigFile).toMatch(/prompts\.json$/);
    });
  });

  describe("embedding defaults", () => {
    it("returns correct defaults when no env vars set", async () => {
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.provider).toBe("ollama");
      expect(embedding.model).toBeUndefined();
      expect(embedding.dimensions).toBeUndefined();
      expect(embedding.baseUrl).toBeUndefined();
      expect(embedding.ollamaLegacyApi).toBe(false);
      expect(embedding.ollamaNumGpu).toBe(999);
      expect(embedding.openaiApiKey).toBeUndefined();
      expect(embedding.cohereApiKey).toBeUndefined();
      expect(embedding.voyageApiKey).toBeUndefined();
      expect(embedding.tune.batchSize).toBe(1024);
      expect(embedding.tune.minBatchSize).toBeUndefined();
      expect(embedding.tune.batchTimeoutMs).toBe(2000);
      expect(embedding.tune.maxRequestsPerMinute).toBeUndefined();
      expect(embedding.tune.retryAttempts).toBe(3);
      expect(embedding.tune.retryDelayMs).toBe(1000);
    });
  });

  describe("provider-specific batch size defaults", () => {
    it("ollama gets batchSize=1024 when not explicitly set", async () => {
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.provider).toBe("ollama");
      expect(embedding.tune.batchSize).toBe(1024);
    });

    it("onnx gets batchSize=32 when not explicitly set", async () => {
      process.env.EMBEDDING_PROVIDER = "onnx";
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(32);
    });

    it("openai gets batchSize=2048 when not explicitly set", async () => {
      process.env.EMBEDDING_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test";
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(2048);
    });

    it("cohere gets batchSize=96 when not explicitly set", async () => {
      process.env.EMBEDDING_PROVIDER = "cohere";
      process.env.COHERE_API_KEY = "test-key";
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(96);
    });

    it("voyage gets batchSize=128 when not explicitly set", async () => {
      process.env.EMBEDDING_PROVIDER = "voyage";
      process.env.VOYAGE_API_KEY = "test-key";
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(128);
    });

    it("explicit EMBEDDING_TUNE_BATCH_SIZE overrides provider default", async () => {
      process.env.EMBEDDING_PROVIDER = "onnx";
      process.env.EMBEDDING_TUNE_BATCH_SIZE = "256";
      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(256);
    });
  });

  describe("fallback chains", () => {
    it("TRANSPORT_MODE (old name) falls back correctly", async () => {
      process.env.TRANSPORT_MODE = "http";
      const { parseAppConfigZod } = await freshImport();
      const { core, deprecations } = parseAppConfigZod();

      expect(core.transportMode).toBe("http");
      expect(deprecations).toContainEqual({
        oldName: "TRANSPORT_MODE",
        newName: "SERVER_TRANSPORT",
      });
    });

    it("HTTP_PORT (old name) falls back correctly", async () => {
      process.env.HTTP_PORT = "8080";
      const { parseAppConfigZod } = await freshImport();
      const { core, deprecations } = parseAppConfigZod();

      expect(core.httpPort).toBe(8080);
      expect(deprecations).toContainEqual({
        oldName: "HTTP_PORT",
        newName: "SERVER_HTTP_PORT",
      });
    });

    it("EMBEDDING_CONCURRENCY (old name) falls back to ingest.tune.pipelineConcurrency", async () => {
      process.env.EMBEDDING_CONCURRENCY = "4";
      const { parseAppConfigZod } = await freshImport();
      const { ingest, deprecations } = parseAppConfigZod();

      expect(ingest.tune.pipelineConcurrency).toBe(4);
      expect(deprecations).toContainEqual({
        oldName: "EMBEDDING_CONCURRENCY",
        newName: "INGEST_PIPELINE_CONCURRENCY",
      });
    });

    it("CODE_BATCH_SIZE falls back as third option for tune.batchSize", async () => {
      process.env.CODE_BATCH_SIZE = "512";
      const { parseAppConfigZod } = await freshImport();
      const { embedding, deprecations } = parseAppConfigZod();

      expect(embedding.tune.batchSize).toBe(512);
      expect(deprecations).toContainEqual({
        oldName: "CODE_BATCH_SIZE",
        newName: "EMBEDDING_TUNE_BATCH_SIZE",
      });
    });
  });

  describe("new name takes priority over old name", () => {
    it("SERVER_TRANSPORT overrides TRANSPORT_MODE", async () => {
      process.env.SERVER_TRANSPORT = "http";
      process.env.TRANSPORT_MODE = "stdio";
      const { parseAppConfigZod } = await freshImport();
      const { core, deprecations } = parseAppConfigZod();

      expect(core.transportMode).toBe("http");
      // No deprecation notice when new name is used
      expect(deprecations.filter((d) => d.oldName === "TRANSPORT_MODE")).toHaveLength(0);
    });

    it("INGEST_PIPELINE_CONCURRENCY overrides EMBEDDING_TUNE_CONCURRENCY", async () => {
      process.env.INGEST_PIPELINE_CONCURRENCY = "8";
      process.env.EMBEDDING_TUNE_CONCURRENCY = "2";
      const { parseAppConfigZod } = await freshImport();
      const { ingest, deprecations } = parseAppConfigZod();

      expect(ingest.tune.pipelineConcurrency).toBe(8);
      expect(deprecations.filter((d) => d.oldName === "EMBEDDING_TUNE_CONCURRENCY")).toHaveLength(0);
    });
  });

  describe("validation errors", () => {
    it("throws readable error for invalid transport mode", async () => {
      process.env.SERVER_TRANSPORT = "grpc";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/transport/i);
    });

    it("throws readable error for invalid port (non-numeric)", async () => {
      process.env.SERVER_HTTP_PORT = "abc";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow();
    });

    it("throws readable error for invalid embedding provider", async () => {
      process.env.EMBEDDING_PROVIDER = "invalid";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/provider/i);
    });

    it("throws readable error for invalid ingest config (non-numeric chunk size)", async () => {
      process.env.INGEST_CHUNK_SIZE = "abc";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/Invalid config \(ingest\)/);
    });

    it("throws readable error for invalid trajectoryGit config (non-numeric timeout)", async () => {
      process.env.TRAJECTORY_GIT_LOG_TIMEOUT_MS = "abc";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/Invalid config \(trajectoryGit\)/);
    });
  });

  describe("API key validation", () => {
    it("throws when openai provider has no API key", async () => {
      process.env.EMBEDDING_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/OPENAI_API_KEY.*required.*openai/i);
    });

    it("throws when cohere provider has no API key", async () => {
      process.env.EMBEDDING_PROVIDER = "cohere";
      delete process.env.COHERE_API_KEY;
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/COHERE_API_KEY.*required.*cohere/i);
    });

    it("throws when voyage provider has no API key", async () => {
      process.env.EMBEDDING_PROVIDER = "voyage";
      delete process.env.VOYAGE_API_KEY;
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).toThrow(/VOYAGE_API_KEY.*required.*voyage/i);
    });

    it("does not throw when openai provider has API key", async () => {
      process.env.EMBEDDING_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).not.toThrow();
    });

    it("does not throw for ollama (no key required)", async () => {
      process.env.EMBEDDING_PROVIDER = "ollama";
      const { parseAppConfigZod } = await freshImport();

      expect(() => parseAppConfigZod()).not.toThrow();
    });
  });

  describe("debug parsing", () => {
    it('parses "true" as true', async () => {
      process.env.DEBUG = "true";
      const { parseAppConfigZod } = await freshImport();
      expect(parseAppConfigZod().core.debug).toBe(true);
    });

    it('parses "1" as true', async () => {
      process.env.DEBUG = "1";
      const { parseAppConfigZod } = await freshImport();
      expect(parseAppConfigZod().core.debug).toBe(true);
    });

    it('parses "false" as false', async () => {
      process.env.DEBUG = "false";
      const { parseAppConfigZod } = await freshImport();
      expect(parseAppConfigZod().core.debug).toBe(false);
    });

    it("parses empty/undefined as false", async () => {
      delete process.env.DEBUG;
      const { parseAppConfigZod } = await freshImport();
      expect(parseAppConfigZod().core.debug).toBe(false);
    });
  });

  describe("embedding provider values", () => {
    it("parses custom env vars for embedding", async () => {
      process.env.EMBEDDING_PROVIDER = "openai";
      process.env.EMBEDDING_MODEL = "text-embedding-3-small";
      process.env.EMBEDDING_DIMENSIONS = "1536";
      process.env.EMBEDDING_BASE_URL = "https://api.openai.com";
      process.env.OPENAI_API_KEY = "sk-test";

      const { parseAppConfigZod } = await freshImport();
      const { embedding } = parseAppConfigZod();

      expect(embedding.provider).toBe("openai");
      expect(embedding.model).toBe("text-embedding-3-small");
      expect(embedding.dimensions).toBe(1536);
      expect(embedding.baseUrl).toBe("https://api.openai.com");
      expect(embedding.openaiApiKey).toBe("sk-test");
    });
  });
});

describe("parseAppConfigZod — ingest", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("INGEST_") ||
        key.startsWith("CODE_") ||
        key === "CHUNKER_POOL_SIZE" ||
        key === "FILE_PROCESSING_CONCURRENCY" ||
        key === "MAX_IO_CONCURRENCY"
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns correct defaults", async () => {
    const { parseAppConfigZod } = await freshImport();
    const { ingest } = parseAppConfigZod();

    expect(ingest.chunkSize).toBe(2500);
    expect(ingest.chunkOverlap).toBe(300);
    expect(ingest.enableAST).toBe(true);
    expect(ingest.enableHybrid).toBe(false);
    expect(ingest.tune.pipelineConcurrency).toBe(1);
    expect(ingest.tune.chunkerPoolSize).toBe(4);
    expect(ingest.tune.fileConcurrency).toBe(50);
    expect(ingest.tune.ioConcurrency).toBe(50);
  });

  it("INGEST_CHUNK_SIZE falls back from CODE_CHUNK_SIZE", async () => {
    process.env.CODE_CHUNK_SIZE = "1500";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.chunkSize).toBe(1500);
    expect(deprecations).toContainEqual({
      oldName: "CODE_CHUNK_SIZE",
      newName: "INGEST_CHUNK_SIZE",
    });
  });

  it("INGEST_ENABLE_AST falls back from CODE_ENABLE_AST", async () => {
    process.env.CODE_ENABLE_AST = "false";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.enableAST).toBe(false);
    expect(deprecations).toContainEqual({
      oldName: "CODE_ENABLE_AST",
      newName: "INGEST_ENABLE_AST",
    });
  });

  it("enableAST defaults to true (not false like other booleans)", async () => {
    const { parseAppConfigZod } = await freshImport();
    const { ingest } = parseAppConfigZod();
    expect(ingest.enableAST).toBe(true);
  });

  it("INGEST_TUNE_CHUNKER_POOL_SIZE falls back from CHUNKER_POOL_SIZE", async () => {
    process.env.CHUNKER_POOL_SIZE = "8";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.tune.chunkerPoolSize).toBe(8);
    expect(deprecations).toContainEqual({
      oldName: "CHUNKER_POOL_SIZE",
      newName: "INGEST_TUNE_CHUNKER_POOL_SIZE",
    });
  });

  it("INGEST_TUNE_FILE_CONCURRENCY falls back from FILE_PROCESSING_CONCURRENCY", async () => {
    process.env.FILE_PROCESSING_CONCURRENCY = "100";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.tune.fileConcurrency).toBe(100);
    expect(deprecations).toContainEqual({
      oldName: "FILE_PROCESSING_CONCURRENCY",
      newName: "INGEST_TUNE_FILE_CONCURRENCY",
    });
  });

  it("INGEST_TUNE_IO_CONCURRENCY falls back from MAX_IO_CONCURRENCY", async () => {
    process.env.MAX_IO_CONCURRENCY = "25";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.tune.ioConcurrency).toBe(25);
    expect(deprecations).toContainEqual({
      oldName: "MAX_IO_CONCURRENCY",
      newName: "INGEST_TUNE_IO_CONCURRENCY",
    });
  });

  it("new name takes priority over old name", async () => {
    process.env.INGEST_CHUNK_SIZE = "3000";
    process.env.CODE_CHUNK_SIZE = "1500";
    const { parseAppConfigZod } = await freshImport();
    const { ingest, deprecations } = parseAppConfigZod();

    expect(ingest.chunkSize).toBe(3000);
    expect(deprecations.filter((d) => d.oldName === "CODE_CHUNK_SIZE")).toHaveLength(0);
  });
});

describe("parseAppConfigZod — trajectoryGit", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TRAJECTORY_GIT_") || key.startsWith("GIT_") || key === "CODE_ENABLE_GIT_METADATA") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns correct defaults", async () => {
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit } = parseAppConfigZod();

    expect(trajectoryGit.enabled).toBe(false);
    expect(trajectoryGit.logMaxAgeMonths).toBe(12);
    expect(trajectoryGit.logTimeoutMs).toBe(60000);
    expect(trajectoryGit.chunkConcurrency).toBe(10);
    expect(trajectoryGit.chunkMaxAgeMonths).toBe(6);
    expect(trajectoryGit.chunkTimeoutMs).toBe(120000);
    expect(trajectoryGit.chunkMaxFileLines).toBe(10000);
    expect(trajectoryGit.squashAwareSessions).toBe(false);
    expect(trajectoryGit.sessionGapMinutes).toBe(30);
  });

  it("TRAJECTORY_GIT_ENABLED falls back from CODE_ENABLE_GIT_METADATA", async () => {
    process.env.CODE_ENABLE_GIT_METADATA = "true";
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit, deprecations } = parseAppConfigZod();

    expect(trajectoryGit.enabled).toBe(true);
    expect(deprecations).toContainEqual({
      oldName: "CODE_ENABLE_GIT_METADATA",
      newName: "TRAJECTORY_GIT_ENABLED",
    });
  });

  it("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS falls back from GIT_LOG_MAX_AGE_MONTHS", async () => {
    process.env.GIT_LOG_MAX_AGE_MONTHS = "24";
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit, deprecations } = parseAppConfigZod();

    expect(trajectoryGit.logMaxAgeMonths).toBe(24);
    expect(deprecations).toContainEqual({
      oldName: "GIT_LOG_MAX_AGE_MONTHS",
      newName: "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
    });
  });

  it("TRAJECTORY_GIT_CHUNK_CONCURRENCY falls back from GIT_CHUNK_CONCURRENCY", async () => {
    process.env.GIT_CHUNK_CONCURRENCY = "20";
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit, deprecations } = parseAppConfigZod();

    expect(trajectoryGit.chunkConcurrency).toBe(20);
    expect(deprecations).toContainEqual({
      oldName: "GIT_CHUNK_CONCURRENCY",
      newName: "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
    });
  });

  it("new name takes priority over old name", async () => {
    process.env.TRAJECTORY_GIT_ENABLED = "true";
    process.env.CODE_ENABLE_GIT_METADATA = "false";
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit, deprecations } = parseAppConfigZod();

    expect(trajectoryGit.enabled).toBe(true);
    expect(deprecations.filter((d) => d.oldName === "CODE_ENABLE_GIT_METADATA")).toHaveLength(0);
  });

  it("logMaxAgeMonths accepts float values", async () => {
    process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS = "6.5";
    const { parseAppConfigZod } = await freshImport();
    const { trajectoryGit } = parseAppConfigZod();

    expect(trajectoryGit.logMaxAgeMonths).toBe(6.5);
  });
});

describe("parseAppConfigZod — qdrantTune", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("QDRANT_TUNE_") ||
        key.startsWith("QDRANT_UPSERT_") ||
        key.startsWith("QDRANT_DELETE_") ||
        key.startsWith("QDRANT_BATCH_") ||
        key.startsWith("QDRANT_FLUSH_") ||
        key === "CODE_BATCH_SIZE" ||
        key === "DELETE_BATCH_SIZE" ||
        key === "DELETE_CONCURRENCY" ||
        key === "DELETE_FLUSH_TIMEOUT_MS"
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns correct defaults", async () => {
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune } = parseAppConfigZod();

    expect(qdrantTune.upsertBatchSize).toBe(100);
    expect(qdrantTune.upsertFlushIntervalMs).toBe(500);
    expect(qdrantTune.upsertOrdering).toBe("weak");
    expect(qdrantTune.deleteBatchSize).toBe(500);
    expect(qdrantTune.deleteConcurrency).toBe(8);
    expect(qdrantTune.deleteFlushTimeoutMs).toBe(1000);
  });

  it("QDRANT_TUNE_UPSERT_BATCH_SIZE falls back through QDRANT_UPSERT_BATCH_SIZE then CODE_BATCH_SIZE", async () => {
    process.env.CODE_BATCH_SIZE = "200";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune, deprecations } = parseAppConfigZod();

    expect(qdrantTune.upsertBatchSize).toBe(200);
    expect(deprecations).toContainEqual({
      oldName: "CODE_BATCH_SIZE",
      newName: "QDRANT_TUNE_UPSERT_BATCH_SIZE",
    });
  });

  it("QDRANT_TUNE_UPSERT_BATCH_SIZE falls back through QDRANT_UPSERT_BATCH_SIZE", async () => {
    process.env.QDRANT_UPSERT_BATCH_SIZE = "150";
    process.env.CODE_BATCH_SIZE = "200";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune, deprecations } = parseAppConfigZod();

    expect(qdrantTune.upsertBatchSize).toBe(150);
    expect(deprecations).toContainEqual({
      oldName: "QDRANT_UPSERT_BATCH_SIZE",
      newName: "QDRANT_TUNE_UPSERT_BATCH_SIZE",
    });
  });

  it("QDRANT_TUNE_DELETE_BATCH_SIZE falls back through QDRANT_DELETE_BATCH_SIZE then DELETE_BATCH_SIZE", async () => {
    process.env.DELETE_BATCH_SIZE = "1000";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune, deprecations } = parseAppConfigZod();

    expect(qdrantTune.deleteBatchSize).toBe(1000);
    expect(deprecations).toContainEqual({
      oldName: "DELETE_BATCH_SIZE",
      newName: "QDRANT_TUNE_DELETE_BATCH_SIZE",
    });
  });

  it("upsertOrdering validates enum values", async () => {
    process.env.QDRANT_TUNE_UPSERT_ORDERING = "strong";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune } = parseAppConfigZod();

    expect(qdrantTune.upsertOrdering).toBe("strong");
  });

  it("upsertOrdering rejects invalid values", async () => {
    process.env.QDRANT_TUNE_UPSERT_ORDERING = "invalid";
    const { parseAppConfigZod } = await freshImport();

    expect(() => parseAppConfigZod()).toThrow(/qdrantTune/i);
  });

  it("QDRANT_TUNE_DELETE_CONCURRENCY falls back through QDRANT_DELETE_CONCURRENCY then DELETE_CONCURRENCY", async () => {
    process.env.DELETE_CONCURRENCY = "16";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune, deprecations } = parseAppConfigZod();

    expect(qdrantTune.deleteConcurrency).toBe(16);
    expect(deprecations).toContainEqual({
      oldName: "DELETE_CONCURRENCY",
      newName: "QDRANT_TUNE_DELETE_CONCURRENCY",
    });
  });

  it("new name takes priority over old names", async () => {
    process.env.QDRANT_TUNE_UPSERT_BATCH_SIZE = "300";
    process.env.QDRANT_UPSERT_BATCH_SIZE = "150";
    process.env.CODE_BATCH_SIZE = "200";
    const { parseAppConfigZod } = await freshImport();
    const { qdrantTune, deprecations } = parseAppConfigZod();

    expect(qdrantTune.upsertBatchSize).toBe(300);
    expect(deprecations.filter((d) => d.oldName === "QDRANT_UPSERT_BATCH_SIZE")).toHaveLength(0);
    expect(
      deprecations.filter((d) => d.oldName === "CODE_BATCH_SIZE" && d.newName === "QDRANT_TUNE_UPSERT_BATCH_SIZE"),
    ).toHaveLength(0);
  });
});

describe("getConfigDump", () => {
  it("returns flat key-value map", async () => {
    const { getConfigDump } = await freshImport();

    const dump = getConfigDump({
      core: { debug: false, qdrantUrl: "http://localhost:6333" },
      embedding: { provider: "ollama", tune: { batchSize: 1024 } },
      ingest: { tune: { pipelineConcurrency: 1 } },
    });

    expect(dump).toEqual({
      "core.debug": false,
      "core.qdrantUrl": "http://localhost:6333",
      "embedding.provider": "ollama",
      "embedding.tune.batchSize": 1024,
      "ingest.tune.pipelineConcurrency": 1,
    });
  });
});

describe("printDeprecationWarnings", () => {
  it("outputs to stderr when there are deprecation notices", async () => {
    const { printDeprecationWarnings } = await freshImport();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    printDeprecationWarnings([{ oldName: "TRANSPORT_MODE", newName: "SERVER_TRANSPORT" }]);

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("TRANSPORT_MODE");
    expect(output).toContain("SERVER_TRANSPORT");

    stderrSpy.mockRestore();
  });

  it("does nothing when notices array is empty", async () => {
    const { printDeprecationWarnings } = await freshImport();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    printDeprecationWarnings([]);

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});
