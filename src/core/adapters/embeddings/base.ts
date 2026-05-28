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
  /**
   * Currently-active base URL for remote providers. Reflects the runtime
   * failover state (Ollama: when usingFallback, returns the fallback URL).
   * Undefined for local providers (e.g. ONNX).
   */
  getBaseUrl?: () => string;
  /**
   * Configured PRIMARY base URL — what the operator wired up at startup.
   * Ignores runtime failover state. Used by display/persistence contexts
   * (prime CLI infraHealth, registry write, doctor) that want what was
   * CONFIGURED, not "which URL we happen to be using right now". Falls
   * back to `getBaseUrl()` when an implementation doesn't expose it.
   */
  getPrimaryBaseUrl?: () => string;
  /**
   * Configured fallback base URL (Ollama with EMBEDDING_FALLBACK_URL).
   * Returns undefined when none configured or N/A. Surfaced via
   * IndexStatus.infraHealth.embedding.fallbackUrl so the prime CLI digest
   * can show both endpoints — symmetric with QDRANT_URL tracking.
   */
  getFallbackBaseUrl?: () => string | undefined;
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
