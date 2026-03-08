export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

export interface RateLimitConfig {
  maxRequestsPerMinute?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export interface EmbeddingProvider {
  embed: (text: string) => Promise<EmbeddingResult>;
  embedBatch: (texts: string[]) => Promise<EmbeddingResult[]>;
  getDimensions: () => number;
  getModel: () => string;
  /** Optimal batch size detected by GPU calibration. Undefined if not available. */
  recommendedBatchSize?: number;
  /** Optional eager initialization (e.g. for ONNX daemon connection) */
  initialize?: () => Promise<void>;
}

export interface ProviderConfig {
  model?: string;
  dimensions?: number;
  rateLimitConfig?: RateLimitConfig;
  apiKey?: string;
  baseUrl?: string;
}
