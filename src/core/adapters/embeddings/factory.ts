import type { EmbeddingConfig } from "../../../bootstrap/config.js";
import type { EmbeddingProvider } from "./base.js";
import { CohereEmbeddings } from "./cohere.js";
import { OllamaEmbeddings } from "./ollama.js";
import { OpenAIEmbeddings } from "./openai.js";
import { VoyageEmbeddings } from "./voyage.js";

export type EmbeddingProviderType = "openai" | "cohere" | "voyage" | "ollama";

export class EmbeddingProviderFactory {
  static create(config: EmbeddingConfig): EmbeddingProvider {
    const { provider, model, dimensions, baseUrl, tune } = config;

    const rateLimitConfig = {
      maxRequestsPerMinute: tune.maxRequestsPerMinute,
      retryAttempts: tune.retryAttempts,
      retryDelayMs: tune.retryDelayMs,
    };

    switch (provider) {
      case "openai":
        if (!config.openaiApiKey) {
          throw new Error("API key is required for OpenAI provider");
        }
        return new OpenAIEmbeddings(
          config.openaiApiKey,
          model || "text-embedding-3-small",
          dimensions,
          rateLimitConfig,
        );

      case "cohere":
        if (!config.cohereApiKey) {
          throw new Error("API key is required for Cohere provider");
        }
        return new CohereEmbeddings(config.cohereApiKey, model || "embed-english-v3.0", dimensions, rateLimitConfig);

      case "voyage":
        if (!config.voyageApiKey) {
          throw new Error("API key is required for Voyage AI provider");
        }
        return new VoyageEmbeddings(
          config.voyageApiKey,
          model || "voyage-2",
          dimensions,
          rateLimitConfig,
          baseUrl || "https://api.voyageai.com/v1",
        );

      case "ollama":
        return new OllamaEmbeddings(
          model || "unclemusclez/jina-embeddings-v2-base-code:latest",
          dimensions,
          rateLimitConfig,
          baseUrl || "http://localhost:11434",
          config.ollamaLegacyApi,
          config.ollamaNumGpu,
        );

      default:
        throw new Error(
          `Unknown embedding provider: ${String(provider)}. Supported providers: openai, cohere, voyage, ollama`,
        );
    }
  }
}
