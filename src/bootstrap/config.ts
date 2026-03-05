// src/bootstrap/config.ts — merged from config/env.ts + config/validate.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CODE_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,
} from "../core/ingest/config.js";
import { DEFAULT_SEARCH_LIMIT } from "../core/search/config.js";
import type { CodeConfig } from "../core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  qdrantUrl: string;
  qdrantApiKey?: string;
  embeddingProvider: string;
  transportMode: "stdio" | "http";
  httpPort: number;
  requestTimeoutMs: number;
  promptsConfigFile: string;
  code: CodeConfig;
}

export function parseAppConfig(): AppConfig {
  const transportMode = (process.env.TRANSPORT_MODE || "stdio").toLowerCase();

  return {
    qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
    qdrantApiKey: process.env.QDRANT_API_KEY,
    embeddingProvider: (process.env.EMBEDDING_PROVIDER || "ollama").toLowerCase(),
    transportMode: transportMode as "stdio" | "http",
    httpPort: parseInt(process.env.HTTP_PORT || "3000", 10),
    requestTimeoutMs: parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || "300000", 10),
    promptsConfigFile: process.env.PROMPTS_CONFIG_FILE || join(__dirname, "../../prompts.json"),
    code: {
      chunkSize: parseInt(process.env.CODE_CHUNK_SIZE || String(DEFAULT_CHUNK_SIZE), 10),
      chunkOverlap: parseInt(process.env.CODE_CHUNK_OVERLAP || String(DEFAULT_CHUNK_OVERLAP), 10),
      enableASTChunking: process.env.CODE_ENABLE_AST !== "false",
      supportedExtensions: DEFAULT_CODE_EXTENSIONS,
      ignorePatterns: DEFAULT_IGNORE_PATTERNS,
      batchSize: parseInt(
        process.env.QDRANT_UPSERT_BATCH_SIZE || process.env.CODE_BATCH_SIZE || String(DEFAULT_BATCH_SIZE),
        10,
      ),
      defaultSearchLimit: parseInt(process.env.CODE_SEARCH_LIMIT || String(DEFAULT_SEARCH_LIMIT), 10),
      enableHybridSearch: process.env.CODE_ENABLE_HYBRID === "true",
      enableGitMetadata: (process.env.TRAJECTORY_GIT_ENABLED ?? process.env.CODE_ENABLE_GIT_METADATA) === "true",
      squashAwareSessions: process.env.TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS === "true",
      sessionGapMinutes: parseInt(process.env.TRAJECTORY_GIT_SESSION_GAP_MINUTES || "30", 10),
    },
  };
}

// --- validateConfig (was config/validate.ts) ---

const VALID_PROVIDERS = ["ollama", "openai", "cohere", "voyage"];
const VALID_TRANSPORT_MODES = ["stdio", "http"];

const PROVIDER_API_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  cohere: "COHERE_API_KEY",
  voyage: "VOYAGE_API_KEY",
};

export function validateConfig(config: AppConfig): void {
  // Validate transport mode
  if (!VALID_TRANSPORT_MODES.includes(config.transportMode)) {
    throw new Error(
      `Invalid transport mode "${config.transportMode}". Supported: ${VALID_TRANSPORT_MODES.join(", ")}.`,
    );
  }

  // Validate HTTP port (only when HTTP mode)
  if (config.transportMode === "http") {
    if (Number.isNaN(config.httpPort) || config.httpPort < 1 || config.httpPort > 65535) {
      throw new Error(`Invalid HTTP port "${config.httpPort}". Must be between 1 and 65535.`);
    }

    if (Number.isNaN(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
      throw new Error(`Invalid request timeout "${config.requestTimeoutMs}". Must be a positive number.`);
    }
  }

  // Validate embedding provider
  if (!VALID_PROVIDERS.includes(config.embeddingProvider)) {
    throw new Error(
      `Unknown embedding provider "${config.embeddingProvider}". Supported: ${VALID_PROVIDERS.join(", ")}.`,
    );
  }

  // Validate API keys for non-ollama providers
  if (config.embeddingProvider !== "ollama") {
    const requiredKeyName = PROVIDER_API_KEY_MAP[config.embeddingProvider];
    if (requiredKeyName && !process.env[requiredKeyName]) {
      throw new Error(`${requiredKeyName} is required for ${config.embeddingProvider} provider.`);
    }
  }
}
