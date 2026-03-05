import { describe, expect, it } from "vitest";

import type { EmbeddingConfig } from "../../../../src/bootstrap/config/index.js";
import { CohereEmbeddings } from "../../../../src/core/adapters/embeddings/cohere.js";
import { EmbeddingProviderFactory } from "../../../../src/core/adapters/embeddings/factory.js";
import { OllamaEmbeddings } from "../../../../src/core/adapters/embeddings/ollama.js";
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
      it("should throw error for unknown provider", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "unknown" as any }))).toThrow(
          "Unknown embedding provider: unknown",
        );
      });

      it("should list supported providers in error message", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "invalid" as any }))).toThrow(
          "openai, cohere, voyage, ollama",
        );
      });
    });

    describe("OpenAI provider", () => {
      it("should throw error if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "openai" }))).toThrow(
          "API key is required for OpenAI provider",
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
      it("should throw error if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "cohere" }))).toThrow(
          "API key is required for Cohere provider",
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
      it("should throw error if API key is missing", () => {
        expect(() => EmbeddingProviderFactory.create(makeConfig({ provider: "voyage" }))).toThrow(
          "API key is required for Voyage AI provider",
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
    });
  });
});
