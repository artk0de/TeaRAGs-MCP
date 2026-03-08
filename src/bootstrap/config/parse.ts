import {
  coreSchema,
  embeddingSchema,
  ingestSchema,
  qdrantTuneSchema,
  trajectoryGitSchema,
  type CoreConfig,
  type EmbeddingConfig,
  type IngestConfig,
  type QdrantTuneConfig,
  type TrajectoryGitConfig,
} from "./schemas.js";
import { envWithFallback, type DeprecationNotice } from "./utils.js";

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

  const userSetBatchSize = env("EMBEDDING_TUNE_BATCH_SIZE", "EMBEDDING_BATCH_SIZE", "CODE_BATCH_SIZE");

  const embeddingTuneInput = {
    batchSize: userSetBatchSize,
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
    device: env("EMBEDDING_DEVICE"),
    baseUrl: env("EMBEDDING_BASE_URL"),
    ollamaLegacyApi: env("OLLAMA_LEGACY_API"),
    ollamaNumGpu: env("OLLAMA_NUM_GPU"),
    openaiApiKey: env("OPENAI_API_KEY"),
    cohereApiKey: env("COHERE_API_KEY"),
    voyageApiKey: env("VOYAGE_API_KEY"),
    tune: embeddingTuneInput,
  };

  const ingestTuneInput = {
    pipelineConcurrency: env("INGEST_PIPELINE_CONCURRENCY", "EMBEDDING_TUNE_CONCURRENCY", "EMBEDDING_CONCURRENCY"),
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
  if (embedding.provider !== "ollama" && embedding.provider !== "onnx") {
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

  // Apply provider-specific batch size default if not explicitly set
  if (!userSetBatchSize) {
    const providerBatchDefaults: Record<string, number> = {
      onnx: 32,
      ollama: 1024,
      openai: 2048,
      cohere: 96,
      voyage: 128,
    };
    embedding.tune.batchSize = providerBatchDefaults[embedding.provider] ?? 1024;
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
