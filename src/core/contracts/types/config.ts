export interface EmbeddingTuneConfig {
  batchSize: number;
  minBatchSize?: number;
  batchTimeoutMs: number;
  maxRequestsPerMinute?: number;
  retryAttempts: number;
  retryDelayMs: number;
  /** Attempts for the pre-indexing embedding health probe (resilient against event-loop starvation). */
  healthCheckRetryAttempts: number;
  /** Pause between health-probe attempts (ms) — yields the event loop. */
  healthCheckRetryDelayMs: number;
}

export interface EmbeddingConfig {
  provider: "ollama" | "openai" | "cohere" | "voyage" | "onnx";
  model?: string;
  dimensions?: number;
  device: string;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  ollamaLegacyApi: boolean;
  ollamaNumGpu: number;
  openaiApiKey?: string;
  cohereApiKey?: string;
  voyageApiKey?: string;
  tune: EmbeddingTuneConfig;
}

export interface TrajectoryGitConfig {
  enabled: boolean;
  logMaxAgeMonths: number;
  logTimeoutMs: number;
  chunkConcurrency: number;
  chunkMaxAgeMonths: number;
  chunkTimeoutMs: number;
  chunkMaxFileLines: number;
  squashAwareSessions: boolean;
  sessionGapMinutes: number;
}

export interface QdrantTuneConfig {
  upsertBatchSize: number;
  upsertFlushIntervalMs: number;
  upsertOrdering: "weak" | "medium" | "strong";
  deleteBatchSize: number;
  deleteConcurrency: number;
  deleteFlushTimeoutMs: number;
  quantizationScalar: boolean;
  /** Enable Qdrant 1.18 TurboQuant 8x dense quantization (default true). */
  turboQuant: boolean;
  /** Reject memory-consuming writes above N% resident RAM (1-100). Unset = off. */
  maxResidentMemoryPercent?: number;
  /** Cap batch-search query size. Unset = no cap. */
  searchMaxBatchsize?: number;
  /** Force the embedded daemon to keep storage on disk to minimize RAM (default false). */
  lowMemory: boolean;
}
