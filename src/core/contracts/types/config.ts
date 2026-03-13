export interface EmbeddingTuneConfig {
  batchSize: number;
  minBatchSize?: number;
  batchTimeoutMs: number;
  maxRequestsPerMinute?: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export interface EmbeddingConfig {
  provider: "ollama" | "openai" | "cohere" | "voyage" | "onnx";
  model?: string;
  dimensions?: number;
  device: string;
  baseUrl?: string;
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
}
