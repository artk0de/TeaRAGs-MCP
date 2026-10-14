// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

import { homedir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../contracts/types/config.js";
import { ConfigValueInvalidError, ConfigValueMissingError } from "../../primitives/errors/index.js";
import type { EmbeddingProvider } from "./base.js";
import { CohereEmbeddings } from "./cohere.js";
import { EmbeddingEndpointDownVerdictStore } from "./endpoint-down-verdicts.js";
import { LLAMA_SERVER_DEFAULT_URL, LlamaServerEmbeddings } from "./llama-server/provider.js";
import { OllamaEmbeddings } from "./ollama.js";
import { DEFAULT_ONNX_MODEL, OnnxEmbeddings } from "./onnx.js";
import { OpenAIEmbeddings } from "./openai.js";
import { VoyageEmbeddings } from "./voyage.js";

export type EmbeddingProviderType = "openai" | "cohere" | "voyage" | "ollama" | "onnx" | "llama-server";

export interface EmbeddingPaths {
  models: string;
  daemonSocket: string;
  daemonPid: string;
  /** Cross-process endpoint-down verdict file (llama-server); absent → no verdicts are shared. */
  endpointDownVerdicts?: string;
}

/* v8 ignore start -- fallback for backward compat when DI paths not provided */
function fallbackPaths(): EmbeddingPaths {
  const appData = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  return {
    models: join(appData, "models"),
    daemonSocket: join(appData, "onnx.sock"),
    daemonPid: join(appData, "onnx-daemon.pid"),
    endpointDownVerdicts: join(appData, "embedding-endpoint-health.json"),
  };
}
/* v8 ignore stop */

function rejectOllamaEndpointList(variable: string, value: string | undefined): void {
  if (!value?.includes(",")) return;
  throw new ConfigValueInvalidError(
    `${variable} (provider: ollama)`,
    value,
    "a single URL - the ollama provider supports one endpoint per role; comma-separated lists are llama-server only",
  );
}

function endpointDownVerdictStore(paths: EmbeddingPaths | undefined): EmbeddingEndpointDownVerdictStore | undefined {
  const file = (paths ?? fallbackPaths()).endpointDownVerdicts;
  return file === undefined ? undefined : new EmbeddingEndpointDownVerdictStore(file);
}

export class EmbeddingProviderFactory {
  static create(config: EmbeddingConfig, paths?: EmbeddingPaths): EmbeddingProvider {
    const { provider, model, dimensions, baseUrl, tune } = config;

    const rateLimitConfig = {
      maxRequestsPerMinute: tune.maxRequestsPerMinute,
      retryAttempts: tune.retryAttempts,
      retryDelayMs: tune.retryDelayMs,
      unavailableRetryMaxWaitMs: tune.unavailableRetryMaxWaitMs,
      unavailableRetryBaseDelayMs: tune.unavailableRetryBaseDelayMs,
      failoverConsecutiveFailures: tune.failoverConsecutiveFailures,
      ollamaQuantization: config.ollamaQuantization,
      ollamaAutoPull: config.autoPull,
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
        // Ollama holds exactly one endpoint per role (failover is a boolean
        // flip); only the llama-server pool parses a comma list. The raw list
        // reached fetch as one URL and surfaced as a silent ERR_INVALID_URL.
        rejectOllamaEndpointList("EMBEDDING_BASE_URL", baseUrl);
        rejectOllamaEndpointList("EMBEDDING_FALLBACK_URL", config.fallbackBaseUrl);
        return new OllamaEmbeddings(
          model || "unclemusclez/jina-embeddings-v2-base-code:latest",
          dimensions,
          rateLimitConfig,
          baseUrl || "http://localhost:11434",
          config.ollamaLegacyApi,
          config.ollamaNumGpu,
          config.fallbackBaseUrl,
        );

      case "llama-server":
        return new LlamaServerEmbeddings(
          model || "unclemusclez/jina-embeddings-v2-base-code:latest",
          dimensions,
          rateLimitConfig,
          baseUrl || LLAMA_SERVER_DEFAULT_URL,
          config.fallbackBaseUrl,
          config.apiKey,
          { endpointDownVerdicts: endpointDownVerdictStore(paths) },
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
          "ollama | llama-server | onnx | openai | cohere | voyage",
        );
    }
  }
}
