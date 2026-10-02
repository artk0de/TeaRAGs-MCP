// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

export interface RateLimitConfig {
  maxRequestsPerMinute?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  /**
   * Bounded wall-clock budget (ms) to keep retrying a connection-level
   * "provider not reachable" failure while the host recovers, before aborting.
   * A remote embedding host under sustained load can flap (crash/restart →
   * briefly unreachable → recover when idle); waiting rather than aborting on
   * the first failure keeps a long index alive. 0 disables the wait (abort on
   * first connection failure — the backward-compatible default). Ollama-only.
   */
  unavailableRetryMaxWaitMs?: number;
  /** Base backoff (ms) between connection-recovery attempts; exponential, capped. Ollama-only. */
  unavailableRetryBaseDelayMs?: number;
  /**
   * Consecutive failed embed calls on the primary (transport error, timeout,
   * 5xx, malformed response — never a caller-side 4xx) after which the provider
   * fails over to its configured fallback endpoint, even while the primary
   * still passes its health probe. 0 disables. Ollama-only; default 3.
   */
  failoverConsecutiveFailures?: number;
  /**
   * Requested server-side model quantization for Ollama: `turbo` (most
   * aggressive), a concrete gguf level (`q4_K_M`, `q5_K_M`, `q8_0`), or
   * `off`. The provider provisions the quantized model copy over /api/create
   * and embeds against it; a server that cannot quantize warns and keeps the
   * unquantized model. Undefined at the class level (off) — the product
   * default lives in the config schema so directly-constructed instances
   * never touch the network for provisioning. Ollama-only.
   */
  ollamaQuantization?: string;
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
  /**
   * Live reachability probe of the configured fallback endpoint, independent of
   * runtime failover state. Returns undefined when no fallback is configured (or
   * the provider has no fallback concept). Surfaced via
   * IndexStatus.infraHealth.embedding.fallbackAvailable so the prime CLI digest
   * shows whether the backup endpoint is up — `checkHealth` only probes the
   * active endpoint and never touches the fallback while the primary is alive.
   */
  checkFallbackHealth?: () => Promise<boolean | undefined>;
  /**
   * Live reachability probe of the CONFIGURED primary endpoint, independent of
   * runtime failover state. Symmetric with `checkFallbackHealth`: `checkHealth`
   * probes whichever endpoint is currently active (the fallback once failover
   * flips), so under failover it can no longer report the primary's health.
   * This probe always targets the configured primary. Returns undefined when
   * the provider has no primary/active distinction (callers then fall back to
   * `checkHealth`). Surfaced via IndexStatus.infraHealth.embedding.primaryAvailable
   * so the prime CLI digest shows BOTH endpoints' health, not just the active one.
   */
  checkPrimaryHealth?: () => Promise<boolean | undefined>;
  /** Resolve model capabilities (context length, dimensions) from provider API. */
  resolveModelInfo?: () => Promise<{ model: string; contextLength: number; dimensions: number } | undefined>;
  /**
   * Watch the batches the SERVER fails on their size and the provider retries
   * in halves internally — invisible to the caller otherwise, because the call
   * still succeeds. While an observer is attached the provider keeps no
   * run-long batch ceiling of its own; the observer owns the working size.
   * Returns the detach. Absent on providers that never split a batch.
   */
  observeServerBatchFailures?: (observer: (event: EmbeddingServerBatchFailure) => void) => () => void;
}

/** A native batch the embedding server failed on its SIZE (bd tea-rags-mcp-7ju66). */
export interface EmbeddingServerBatchFailure {
  /** Texts in the batch that failed. */
  failedSize: number;
  /** Size the provider retries the batch's slices at. */
  retrySize: number;
  /** Endpoint the batch went to. */
  endpointUrl?: string;
}

export interface ProviderConfig {
  model?: string;
  dimensions?: number;
  rateLimitConfig?: RateLimitConfig;
  apiKey?: string;
  baseUrl?: string;
}
