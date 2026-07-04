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
  /**
   * Bounded wall-clock budget (ms) to keep retrying a connection-level
   * "provider not reachable" failure while the host recovers, before aborting
   * the index. A remote embedding host under sustained load can flap; waiting
   * rather than aborting on the first failure keeps a long index alive.
   */
  unavailableRetryMaxWaitMs: number;
  /** Base backoff (ms) between connection-recovery attempts; exponential, capped. */
  unavailableRetryBaseDelayMs: number;
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

/**
 * VCS history-access adapter selection (GIT_ADAPTER env var).
 * Literal union kept inline — contracts/ imports nothing from core/;
 * `GitAdapterKind` in adapters/vcs stays assignable via structural typing.
 */
export interface VcsConfig {
  /** "git" = CLI subprocess adapter (default), "es-git" = in-process libgit2. */
  adapter: "git" | "es-git";
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
