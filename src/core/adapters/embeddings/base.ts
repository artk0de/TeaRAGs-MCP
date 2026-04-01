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
  /** Lightweight health check — returns true if provider is reachable. */
  checkHealth: () => Promise<boolean>;
  /** Provider identifier (e.g. "ollama", "onnx", "openai"). */
  getProviderName: () => string;
  /** Base URL for remote providers. Undefined for local (e.g. ONNX). */
  getBaseUrl?: () => string;
  /** Resolve model capabilities (context length, dimensions) from provider API. */
  resolveModelInfo?: () => Promise<{ model: string; contextLength: number; dimensions: number } | undefined>;
}

export interface ProviderConfig {
  model?: string;
  dimensions?: number;
  rateLimitConfig?: RateLimitConfig;
  apiKey?: string;
  baseUrl?: string;
}
