import { describe, expect, it, vi } from "vitest";

import type { EmbeddingConfig } from "../../../../src/bootstrap/config/index.js";
import { ConfigValueInvalidError, ConfigValueMissingError } from "../../../../src/bootstrap/errors.js";
import { CohereEmbeddings } from "../../../../src/core/adapters/embeddings/cohere.js";
import { EmbeddingProviderFactory } from "../../../../src/core/adapters/embeddings/factory.js";
import { LlamaServerEmbeddings } from "../../../../src/core/adapters/embeddings/llama-server/provider.js";
import { OllamaEmbeddings } from "../../../../src/core/adapters/embeddings/ollama.js";
import { DEFAULT_ONNX_MODEL, OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";
import { OpenAIEmbeddings } from "../../../../src/core/adapters/embeddings/openai.js";
import { VoyageEmbeddings } from "../../../../src/core/adapters/embeddings/voyage.js";

/** Helper to build a minimal EmbeddingConfig with overrides */
function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "ollama",
    model: undefined,
    dimensions: undefined,
    baseUrl: undefined,
    ollamaLegacyApi: false,
    ollamaNumGpu: 999,
    openaiApiKey: undefined,
    cohereApiKey: undefined,
    voyageApiKey: undefined,
    tune: {
      concurrency: 1,
      batchSize: 1024,
      minBatchSize: undefined,
      batchTimeoutMs: 2000,
      maxRequestsPerMinute: undefined,
      retryAttempts: 3,
      retryDelayMs: 1000,
    },
    ...overrides,
  };
}

describe("EmbeddingProviderFactory", () => {
  describe("create", () => {
    describe("Unknown provider", () => {
      it("should throw ConfigValueInvalidError for unknown provider", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "unknown" as any }))).toThrow(
          ConfigValueInvalidError,
        );
      });

      it("should include provider value in error message", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "invalid" as any }))).toThrow(/invalid/);
      });

      it("lists llama-server among the valid providers", () => {
        const error = (() => {
          try {
            EmbeddingProviderFactory.create(makeConfig({ provider: "invalid" as any }));
          } catch (e) {
            return e as ConfigValueInvalidError;
          }
        })();
        expect(error?.hint).toContain("llama-server");
      });
    });

    describe("OpenAI provider", () => {
      it("should throw ConfigValueMissingError if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "openai" }))).toThrow(
          ConfigValueMissingError,
        );
      });

      it("should create OpenAI provider with API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "openai", openaiApiKey: "test-key" }));

        expect(provider).toBeInstanceOf(OpenAIEmbeddings);
        expect(provider.getModel()).toBe("text-embedding-3-small");
        expect(provider.getDimensions()).toBe(1536);
      });

      it("should use custom model", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "openai", openaiApiKey: "test-key", model: "text-embedding-3-large" }),
        );

        expect(provider.getModel()).toBe("text-embedding-3-large");
        expect(provider.getDimensions()).toBe(3072);
      });

      it("should use custom dimensions", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "openai", openaiApiKey: "test-key", dimensions: 512 }),
        );

        expect(provider.getDimensions()).toBe(512);
      });

      it("should pass rate limit config", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({
            provider: "openai",
            openaiApiKey: "test-key",
            tune: {
              concurrency: 1,
              batchSize: 1024,
              minBatchSize: undefined,
              batchTimeoutMs: 2000,
              maxRequestsPerMinute: 1000,
              retryAttempts: 5,
              retryDelayMs: 2000,
            },
          }),
        );

        expect(provider).toBeInstanceOf(OpenAIEmbeddings);
      });
    });

    describe("Cohere provider", () => {
      it("should throw ConfigValueMissingError if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "cohere" }))).toThrow(
          ConfigValueMissingError,
        );
      });

      it("should create Cohere provider with API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "cohere", cohereApiKey: "test-key" }));

        expect(provider).toBeInstanceOf(CohereEmbeddings);
        expect(provider.getModel()).toBe("embed-english-v3.0");
        expect(provider.getDimensions()).toBe(1024);
      });

      it("should use custom model", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "cohere", cohereApiKey: "test-key", model: "embed-multilingual-v3.0" }),
        );

        expect(provider.getModel()).toBe("embed-multilingual-v3.0");
      });

      it("should use custom dimensions", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "cohere", cohereApiKey: "test-key", dimensions: 384 }),
        );

        expect(provider.getDimensions()).toBe(384);
      });
    });

    describe("Voyage provider", () => {
      it("should throw ConfigValueMissingError if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "voyage" }))).toThrow(
          ConfigValueMissingError,
        );
      });

      it("should create Voyage provider with API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "voyage", voyageApiKey: "test-key" }));

        expect(provider).toBeInstanceOf(VoyageEmbeddings);
        expect(provider.getModel()).toBe("voyage-2");
        expect(provider.getDimensions()).toBe(1024);
      });

      it("should use custom model", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "voyage", voyageApiKey: "test-key", model: "voyage-large-2" }),
        );

        expect(provider.getModel()).toBe("voyage-large-2");
        expect(provider.getDimensions()).toBe(1536);
      });

      it("should use default base URL", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "voyage", voyageApiKey: "test-key" }));

        expect(provider).toBeInstanceOf(VoyageEmbeddings);
      });

      it("should use custom base URL", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "voyage", voyageApiKey: "test-key", baseUrl: "https://custom.voyageai.com/v1" }),
        );

        expect(provider).toBeInstanceOf(VoyageEmbeddings);
      });
    });

    describe("Ollama provider", () => {
      it("should not require API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "ollama" }));

        expect(provider).toBeInstanceOf(OllamaEmbeddings);
        expect(provider.getModel()).toBe("unclemusclez/jina-embeddings-v2-base-code:latest");
        expect(provider.getDimensions()).toBe(768);
      });

      it("should use custom model", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "ollama", model: "mxbai-embed-large" }),
        );

        expect(provider.getModel()).toBe("mxbai-embed-large");
        expect(provider.getDimensions()).toBe(1024);
      });

      it("should use default base URL", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "ollama" }));

        expect(provider).toBeInstanceOf(OllamaEmbeddings);
      });

      it("should use custom base URL", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "ollama", baseUrl: "http://custom:11434" }),
        );

        expect(provider).toBeInstanceOf(OllamaEmbeddings);
      });

      it("should pass ollamaLegacyApi and ollamaNumGpu to constructor", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "ollama", ollamaLegacyApi: true, ollamaNumGpu: 0 }),
        );

        expect(provider).toBeInstanceOf(OllamaEmbeddings);
      });

      it("passes autoPull through, so the first embed probes the model before embedding", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
        try {
          const provider = EmbeddingProviderFactory.create(
            makeConfig({ provider: "ollama", baseUrl: "http://box:11434", autoPull: true }),
          );
          // No network before first need (xi2r9): construction alone must not probe.
          expect(fetchSpy).not.toHaveBeenCalledWith("http://box:11434/api/show", expect.anything());
          void provider.embed("x").catch(() => undefined);
          await vi.waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledWith("http://box:11434/api/show", expect.anything());
          });
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });

    describe("llama-server provider", () => {
      it("returns LlamaServerEmbeddings without requiring an API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "llama-server" }));

        expect(provider).toBeInstanceOf(LlamaServerEmbeddings);
        expect(provider.getProviderName()).toBe("llama-server");
        expect(provider.getModel()).toBe("unclemusclez/jina-embeddings-v2-base-code:latest");
        expect(provider.getBaseUrl?.()).toBe("http://localhost:8080");
      });

      it("passes the peer list, the fallback list and the model through", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({
            provider: "llama-server",
            model: "nomic-embed-text",
            baseUrl: "http://gpu:8081,http://gpu:8082",
            fallbackBaseUrl: "http://127.0.0.1:8080",
          }),
        );

        expect(provider.getModel()).toBe("nomic-embed-text");
        expect(provider.getPrimaryBaseUrl?.()).toBe("http://gpu:8081,http://gpu:8082");
        expect(provider.getFallbackBaseUrl?.()).toBe("http://127.0.0.1:8080");
      });

      it("sends EMBEDDING_API_KEY as a Bearer token", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok" }));
        try {
          const provider = EmbeddingProviderFactory.create(
            makeConfig({ provider: "llama-server", baseUrl: "http://gpu:8081", apiKey: "k1" }),
          );
          await provider.checkHealth();
          expect(fetchSpy).toHaveBeenCalledWith(
            "http://gpu:8081/health",
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k1" }) }),
          );
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });

    describe("ONNX provider", () => {
      it("should not require API key", () => {
        const provider = EmbeddingProviderFactory.create(makeConfig({ provider: "onnx" }));

        expect(provider).toBeInstanceOf(OnnxEmbeddings);
        expect(provider.getModel()).toBe(DEFAULT_ONNX_MODEL);
        expect(provider.getDimensions()).toBe(768);
      });

      it("should use custom model", () => {
        const provider = EmbeddingProviderFactory.create(
          makeConfig({ provider: "onnx", model: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }),
        );

        expect(provider.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
        expect(provider.getDimensions()).toBe(384);
      });
    });
  });
});
