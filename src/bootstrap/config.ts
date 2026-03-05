// src/bootstrap/config.ts — merged from config/env.ts + config/validate.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

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

let _lastZodConfig: ReturnType<typeof parseAppConfigZod> | null = null;

/** Get the full Zod config from the last parseAppConfig() call */
export function getZodConfig(): ReturnType<typeof parseAppConfigZod> {
  if (!_lastZodConfig) throw new Error("parseAppConfig() must be called first");
  return _lastZodConfig;
}

export function parseAppConfig(): AppConfig {
  const zodConfig = parseAppConfigZod();
  _lastZodConfig = zodConfig;

  // Print deprecation warnings at parse time
  printDeprecationWarnings(zodConfig.deprecations);

  // Bridge to old AppConfig shape for consumers
  return {
    qdrantUrl: zodConfig.core.qdrantUrl,
    qdrantApiKey: zodConfig.core.qdrantApiKey,
    embeddingProvider: zodConfig.embedding.provider,
    transportMode: zodConfig.core.transportMode,
    httpPort: zodConfig.core.httpPort,
    requestTimeoutMs: zodConfig.core.requestTimeoutMs,
    promptsConfigFile: zodConfig.core.promptsConfigFile,
    code: {
      chunkSize: zodConfig.ingest.chunkSize,
      chunkOverlap: zodConfig.ingest.chunkOverlap,
      enableASTChunking: zodConfig.ingest.enableAST,
      supportedExtensions: DEFAULT_CODE_EXTENSIONS,
      ignorePatterns: DEFAULT_IGNORE_PATTERNS,
      batchSize: zodConfig.qdrantTune.upsertBatchSize,
      defaultSearchLimit: zodConfig.ingest.defaultSearchLimit,
      enableHybridSearch: zodConfig.ingest.enableHybrid,
      enableGitMetadata: zodConfig.trajectoryGit.enabled,
      squashAwareSessions: zodConfig.trajectoryGit.squashAwareSessions,
      sessionGapMinutes: zodConfig.trajectoryGit.sessionGapMinutes,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// NEW Zod-based config (Task 1 of centralized config)
// ───────────────────────────────────────────────────────────────────────────────

export interface DeprecationNotice {
  oldName: string;
  newName: string;
}

function envWithFallback(
  deprecations: DeprecationNotice[],
  newName: string,
  ...oldNames: string[]
): string | undefined {
  const newVal = process.env[newName];
  if (newVal !== undefined && newVal !== "") return newVal;
  for (const old of oldNames) {
    const oldVal = process.env[old];
    if (oldVal !== undefined && oldVal !== "") {
      deprecations.push({ oldName: old, newName });
      return oldVal;
    }
  }
  return undefined;
}

/** Parse "true"/"1" → true, everything else → false */
const booleanFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Parse string to int, returning undefined for absent/empty values */
const optionalInt = z
  .string()
  .optional()
  .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : undefined))
  .pipe(z.number().int().optional());

/** Parse string to int with a default */
function intWithDefault(defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : defaultValue))
    .pipe(z.number().int());
}

/** Parse string to float with a default */
function floatWithDefault(defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? parseFloat(v) : defaultValue))
    .pipe(z.number());
}

/** Parse "true"/"1" → true, everything else → defaultValue */
function booleanFromEnvWithDefault(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return defaultValue;
      return v === "true" || v === "1";
    });
}

/** Parse string to positive int (optional) */
const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : undefined))
  .pipe(z.number().int().positive().optional());

const coreSchema = z.object({
  debug: booleanFromEnv,
  qdrantUrl: z.string().default("http://localhost:6333"),
  qdrantApiKey: z.string().optional(),
  transportMode: z.enum(["stdio", "http"]),
  httpPort: intWithDefault(3000),
  requestTimeoutMs: intWithDefault(300000),
  promptsConfigFile: z.string().default(join(__dirname, "../../prompts.json")),
});

const embeddingTuneSchema = z.object({
  concurrency: intWithDefault(1),
  batchSize: intWithDefault(1024),
  minBatchSize: optionalInt,
  batchTimeoutMs: intWithDefault(2000),
  maxRequestsPerMinute: optionalPositiveInt,
  retryAttempts: intWithDefault(3),
  retryDelayMs: intWithDefault(1000),
});

const embeddingSchema = z.object({
  provider: z.enum(["ollama", "openai", "cohere", "voyage"]).default("ollama"),
  model: z.string().optional(),
  dimensions: optionalPositiveInt,
  baseUrl: z.string().optional(),
  ollamaLegacyApi: booleanFromEnv,
  ollamaNumGpu: intWithDefault(999),
  openaiApiKey: z.string().optional(),
  cohereApiKey: z.string().optional(),
  voyageApiKey: z.string().optional(),
  tune: embeddingTuneSchema,
});

const ingestTuneSchema = z.object({
  chunkerPoolSize: intWithDefault(4),
  fileConcurrency: intWithDefault(50),
  ioConcurrency: intWithDefault(50),
});

const ingestSchema = z.object({
  chunkSize: intWithDefault(DEFAULT_CHUNK_SIZE),
  chunkOverlap: intWithDefault(DEFAULT_CHUNK_OVERLAP),
  enableAST: booleanFromEnvWithDefault(true),
  enableHybrid: booleanFromEnv,
  defaultSearchLimit: intWithDefault(DEFAULT_SEARCH_LIMIT),
  tune: ingestTuneSchema,
});

const trajectoryGitSchema = z.object({
  enabled: booleanFromEnv,
  logMaxAgeMonths: floatWithDefault(12),
  logTimeoutMs: intWithDefault(60000),
  chunkConcurrency: intWithDefault(10),
  chunkMaxAgeMonths: floatWithDefault(6),
  chunkTimeoutMs: intWithDefault(120000),
  chunkMaxFileLines: intWithDefault(10000),
  squashAwareSessions: booleanFromEnv,
  sessionGapMinutes: intWithDefault(30),
});

const qdrantTuneSchema = z.object({
  upsertBatchSize: intWithDefault(DEFAULT_BATCH_SIZE),
  upsertFlushIntervalMs: intWithDefault(500),
  upsertOrdering: z.enum(["weak", "medium", "strong"]).default("weak"),
  deleteBatchSize: intWithDefault(500),
  deleteConcurrency: intWithDefault(8),
  deleteFlushTimeoutMs: intWithDefault(1000),
});

export type CoreConfig = z.infer<typeof coreSchema>;
export type EmbeddingTuneConfig = z.infer<typeof embeddingTuneSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type IngestTuneConfig = z.infer<typeof ingestTuneSchema>;
export type IngestConfig = z.infer<typeof ingestSchema>;
export type TrajectoryGitConfig = z.infer<typeof trajectoryGitSchema>;
export type QdrantTuneConfig = z.infer<typeof qdrantTuneSchema>;

export function parseAppConfigZod(): {
  core: CoreConfig;
  embedding: EmbeddingConfig;
  ingest: IngestConfig;
  trajectoryGit: TrajectoryGitConfig;
  qdrantTune: QdrantTuneConfig;
  deprecations: DeprecationNotice[];
} {
  const deprecations: DeprecationNotice[] = [];
  const env = (name: string, ...fallbacks: string[]) => envWithFallback(deprecations, name, ...fallbacks);

  const coreInput = {
    debug: env("DEBUG"),
    qdrantUrl: env("QDRANT_URL"),
    qdrantApiKey: env("QDRANT_API_KEY"),
    transportMode: env("SERVER_TRANSPORT", "TRANSPORT_MODE") ?? "stdio",
    httpPort: env("SERVER_HTTP_PORT", "HTTP_PORT"),
    requestTimeoutMs: env("SERVER_HTTP_TIMEOUT_MS", "HTTP_REQUEST_TIMEOUT_MS"),
    promptsConfigFile: env("SERVER_PROMPTS_FILE", "PROMPTS_CONFIG_FILE"),
  };

  const embeddingTuneInput = {
    concurrency: env("EMBEDDING_TUNE_CONCURRENCY", "EMBEDDING_CONCURRENCY"),
    batchSize: env("EMBEDDING_TUNE_BATCH_SIZE", "EMBEDDING_BATCH_SIZE", "CODE_BATCH_SIZE"),
    minBatchSize: env("EMBEDDING_TUNE_MIN_BATCH_SIZE", "MIN_BATCH_SIZE"),
    batchTimeoutMs: env("EMBEDDING_TUNE_BATCH_TIMEOUT_MS", "BATCH_FORMATION_TIMEOUT_MS"),
    maxRequestsPerMinute: env("EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE", "EMBEDDING_MAX_REQUESTS_PER_MINUTE"),
    retryAttempts: env("EMBEDDING_TUNE_RETRY_ATTEMPTS", "EMBEDDING_RETRY_ATTEMPTS"),
    retryDelayMs: env("EMBEDDING_TUNE_RETRY_DELAY_MS", "EMBEDDING_RETRY_DELAY"),
  };

  const embeddingInput = {
    provider: env("EMBEDDING_PROVIDER"),
    model: env("EMBEDDING_MODEL"),
    dimensions: env("EMBEDDING_DIMENSIONS"),
    baseUrl: env("EMBEDDING_BASE_URL"),
    ollamaLegacyApi: env("OLLAMA_LEGACY_API"),
    ollamaNumGpu: env("OLLAMA_NUM_GPU"),
    openaiApiKey: env("OPENAI_API_KEY"),
    cohereApiKey: env("COHERE_API_KEY"),
    voyageApiKey: env("VOYAGE_API_KEY"),
    tune: embeddingTuneInput,
  };

  const ingestTuneInput = {
    chunkerPoolSize: env("INGEST_TUNE_CHUNKER_POOL_SIZE", "CHUNKER_POOL_SIZE"),
    fileConcurrency: env("INGEST_TUNE_FILE_CONCURRENCY", "FILE_PROCESSING_CONCURRENCY"),
    ioConcurrency: env("INGEST_TUNE_IO_CONCURRENCY", "MAX_IO_CONCURRENCY"),
  };

  const ingestInput = {
    chunkSize: env("INGEST_CHUNK_SIZE", "CODE_CHUNK_SIZE"),
    chunkOverlap: env("INGEST_CHUNK_OVERLAP", "CODE_CHUNK_OVERLAP"),
    enableAST: env("INGEST_ENABLE_AST", "CODE_ENABLE_AST"),
    enableHybrid: env("INGEST_ENABLE_HYBRID", "CODE_ENABLE_HYBRID"),
    defaultSearchLimit: env("INGEST_DEFAULT_SEARCH_LIMIT", "CODE_SEARCH_LIMIT"),
    tune: ingestTuneInput,
  };

  const trajectoryGitInput = {
    enabled: env("TRAJECTORY_GIT_ENABLED", "CODE_ENABLE_GIT_METADATA"),
    logMaxAgeMonths: env("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", "GIT_LOG_MAX_AGE_MONTHS"),
    logTimeoutMs: env("TRAJECTORY_GIT_LOG_TIMEOUT_MS", "GIT_LOG_TIMEOUT_MS"),
    chunkConcurrency: env("TRAJECTORY_GIT_CHUNK_CONCURRENCY", "GIT_CHUNK_CONCURRENCY"),
    chunkMaxAgeMonths: env("TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", "GIT_CHUNK_MAX_AGE_MONTHS"),
    chunkTimeoutMs: env("TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", "GIT_CHUNK_TIMEOUT_MS"),
    chunkMaxFileLines: env("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", "GIT_CHUNK_MAX_FILE_LINES"),
    squashAwareSessions: env("TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS"),
    sessionGapMinutes: env("TRAJECTORY_GIT_SESSION_GAP_MINUTES"),
  };

  const qdrantTuneInput = {
    upsertBatchSize: env("QDRANT_TUNE_UPSERT_BATCH_SIZE", "QDRANT_UPSERT_BATCH_SIZE", "CODE_BATCH_SIZE"),
    upsertFlushIntervalMs: env("QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS", "QDRANT_FLUSH_INTERVAL_MS"),
    upsertOrdering: env("QDRANT_TUNE_UPSERT_ORDERING", "QDRANT_BATCH_ORDERING") ?? "weak",
    deleteBatchSize: env("QDRANT_TUNE_DELETE_BATCH_SIZE", "QDRANT_DELETE_BATCH_SIZE", "DELETE_BATCH_SIZE"),
    deleteConcurrency: env("QDRANT_TUNE_DELETE_CONCURRENCY", "QDRANT_DELETE_CONCURRENCY", "DELETE_CONCURRENCY"),
    deleteFlushTimeoutMs: env("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", "DELETE_FLUSH_TIMEOUT_MS"),
  };

  const coreResult = coreSchema.safeParse(coreInput);
  if (!coreResult.success) {
    const issues = coreResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config (core): ${issues}`);
  }

  const embeddingResult = embeddingSchema.safeParse(embeddingInput);
  if (!embeddingResult.success) {
    const issues = embeddingResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config (embedding): ${issues}`);
  }

  const ingestResult = ingestSchema.safeParse(ingestInput);
  if (!ingestResult.success) {
    const issues = ingestResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config (ingest): ${issues}`);
  }

  const trajectoryGitResult = trajectoryGitSchema.safeParse(trajectoryGitInput);
  if (!trajectoryGitResult.success) {
    const issues = trajectoryGitResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config (trajectoryGit): ${issues}`);
  }

  const qdrantTuneResult = qdrantTuneSchema.safeParse(qdrantTuneInput);
  if (!qdrantTuneResult.success) {
    const issues = qdrantTuneResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config (qdrantTune): ${issues}`);
  }

  // Validate API keys for non-ollama providers
  const embedding = embeddingResult.data;
  if (embedding.provider !== "ollama") {
    const keyMap: Record<string, keyof EmbeddingConfig> = {
      openai: "openaiApiKey",
      cohere: "cohereApiKey",
      voyage: "voyageApiKey",
    };
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      cohere: "COHERE_API_KEY",
      voyage: "VOYAGE_API_KEY",
    };
    const keyField = keyMap[embedding.provider];
    if (keyField && !embedding[keyField]) {
      throw new Error(`${envMap[embedding.provider]} is required for ${embedding.provider} provider.`);
    }
  }

  return {
    core: coreResult.data,
    embedding: embeddingResult.data,
    ingest: ingestResult.data,
    trajectoryGit: trajectoryGitResult.data,
    qdrantTune: qdrantTuneResult.data,
    deprecations,
  };
}

export function printDeprecationWarnings(notices: DeprecationNotice[]): void {
  if (notices.length === 0) return;
  const lines = notices.map((n) => `  - ${n.oldName} -> use ${n.newName} instead`).join("\n");
  process.stderr.write(`[tea-rags] Deprecated env vars detected:\n${lines}\n`);
}

export function getConfigDump(config: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  function flatten(obj: object, prefix: string): void {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        flatten(value as object, path);
      } else {
        result[path] = value;
      }
    }
  }

  flatten(config, "");
  return result;
}
