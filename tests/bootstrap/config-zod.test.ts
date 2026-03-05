import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Helper: dynamic import with cache-busting to get fresh module state per test
async function freshImport() {
  vi.resetModules();
  return await import("../../src/bootstrap/config.js");
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
      "EMBEDDING_TUNE_CONCURRENCY",
      "EMBEDDING_CONCURRENCY",
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
      expect(core.qdrantUrl).toBe("http://localhost:6333");
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
      expect(embedding.tune.concurrency).toBe(1);
      expect(embedding.tune.batchSize).toBe(1024);
      expect(embedding.tune.minBatchSize).toBeUndefined();
      expect(embedding.tune.batchTimeoutMs).toBe(2000);
      expect(embedding.tune.maxRequestsPerMinute).toBeUndefined();
      expect(embedding.tune.retryAttempts).toBe(3);
      expect(embedding.tune.retryDelayMs).toBe(1000);
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

    it("EMBEDDING_CONCURRENCY (old name) falls back correctly", async () => {
      process.env.EMBEDDING_CONCURRENCY = "4";
      const { parseAppConfigZod } = await freshImport();
      const { embedding, deprecations } = parseAppConfigZod();

      expect(embedding.tune.concurrency).toBe(4);
      expect(deprecations).toContainEqual({
        oldName: "EMBEDDING_CONCURRENCY",
        newName: "EMBEDDING_TUNE_CONCURRENCY",
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

    it("EMBEDDING_TUNE_CONCURRENCY overrides EMBEDDING_CONCURRENCY", async () => {
      process.env.EMBEDDING_TUNE_CONCURRENCY = "8";
      process.env.EMBEDDING_CONCURRENCY = "2";
      const { parseAppConfigZod } = await freshImport();
      const { embedding, deprecations } = parseAppConfigZod();

      expect(embedding.tune.concurrency).toBe(8);
      expect(deprecations.filter((d) => d.oldName === "EMBEDDING_CONCURRENCY")).toHaveLength(0);
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

describe("getConfigDump", () => {
  it("returns flat key-value map", async () => {
    const { getConfigDump } = await freshImport();

    const dump = getConfigDump({
      core: { debug: false, qdrantUrl: "http://localhost:6333" },
      embedding: { provider: "ollama", tune: { concurrency: 1 } },
    });

    expect(dump).toEqual({
      "core.debug": false,
      "core.qdrantUrl": "http://localhost:6333",
      "embedding.provider": "ollama",
      "embedding.tune.concurrency": 1,
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
