import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigValueInvalidError, ConfigValueMissingError } from "../../../bootstrap/errors.js";
import type { EmbeddingConfig } from "../../contracts/types/config.js";
import type { EmbeddingProvider } from "./base.js";
import { CohereEmbeddings } from "./cohere.js";
import { OllamaEmbeddings } from "./ollama.js";
import { DEFAULT_ONNX_MODEL, OnnxEmbeddings } from "./onnx.js";
import { OpenAIEmbeddings } from "./openai.js";
import { VoyageEmbeddings } from "./voyage.js";

export type EmbeddingProviderType = "openai" | "cohere" | "voyage" | "ollama" | "onnx";

export interface EmbeddingPaths {
  models: string;
  daemonSocket: string;
  daemonPid: string;
}

/* v8 ignore start -- fallback for backward compat when DI paths not provided */
function fallbackPaths(): EmbeddingPaths {
  const appData = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  return {
    models: join(appData, "models"),
    daemonSocket: join(appData, "onnx.sock"),
    daemonPid: join(appData, "onnx-daemon.pid"),
  };
}
/* v8 ignore stop */

export class EmbeddingProviderFactory {
  static create(config: EmbeddingConfig, paths?: EmbeddingPaths): EmbeddingProvider {
    const { provider, model, dimensions, baseUrl, tune } = config;

    const rateLimitConfig = {
      maxRequestsPerMinute: tune.maxRequestsPerMinute,
      retryAttempts: tune.retryAttempts,
      retryDelayMs: tune.retryDelayMs,
    };

    switch (provider) {
      case "openai":
        if (!config.openaiApiKey) {
          throw new ConfigValueMissingError("apiKey", "OPENAI_API_KEY");
        }
        return new OpenAIEmbeddings(
          config.openaiApiKey,
          model || "text-embedding-3-small",
          dimensions,
          rateLimitConfig,
        );

      case "cohere":
        if (!config.cohereApiKey) {
          throw new ConfigValueMissingError("apiKey", "COHERE_API_KEY");
        }
        return new CohereEmbeddings(config.cohereApiKey, model || "embed-english-v3.0", dimensions, rateLimitConfig);

      case "voyage":
        if (!config.voyageApiKey) {
          throw new ConfigValueMissingError("apiKey", "VOYAGE_API_KEY");
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

      case "onnx": {
        const resolved = paths ?? fallbackPaths();
        return new OnnxEmbeddings(
          model || DEFAULT_ONNX_MODEL,
          dimensions,
          resolved.models,
          config.device,
          resolved.daemonSocket,
          resolved.daemonPid,
        );
      }

      default:
        throw new ConfigValueInvalidError(
          "embeddingProvider",
          String(provider),
          "ollama | onnx | openai | cohere | voyage",
        );
    }
  }
}
