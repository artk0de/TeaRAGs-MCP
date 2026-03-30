/**
 * OllamaEmbeddings - OPTIMIZED with native batch API
 *
 * KEY OPTIMIZATION: Uses /api/embed instead of /api/embeddings
 * - /api/embeddings: Single text per request (OLD)
 * - /api/embed: Array of texts in one request (NEW, since Ollama 0.2.0)
 *
 * Performance improvement: N HTTP requests → 1 request
 *
 * Sources:
 * - https://docs.ollama.com/capabilities/embeddings
 * - https://ollama.com/blog/embedding-models
 */

import Bottleneck from "bottleneck";

import { isDebug } from "../../infra/runtime.js";
import type { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";
import { OllamaModelMissingError, OllamaUnavailableError } from "./ollama/errors.js";
import { withRateLimitRetry } from "./retry.js";
import { getModelDimensions } from "./utils/model-dimensions.js";

/** Full request timeout for embed calls (connect + model load + inference) */
const CONNECT_TIMEOUT_MS = 5000;
/** Timeout for lightweight health probe (GET /) */
const HEALTH_PROBE_TIMEOUT_MS = 1000;
/** How long to cache a successful health probe result */
const HEALTH_TTL_MS = 60_000;
/**
 * Per-item timeout budget for batch requests.
 * Total timeout = BATCH_PER_ITEM_TIMEOUT_MS × batchSize + BATCH_BASE_TIMEOUT_MS.
 * Ollama processes batches synchronously — large batches need proportionally more time.
 */
const BATCH_BASE_TIMEOUT_MS = 30_000; // 30s base (model loading, warmup)
const BATCH_PER_ITEM_TIMEOUT_MS = 100; // 100ms per item

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

interface OllamaError {
  status?: number;
  message?: string;
}

// Legacy /api/embeddings response format (single)
interface OllamaEmbedResponse {
  embedding: number[];
}

// New /api/embed response format (batch)
interface OllamaEmbedBatchResponse {
  model: string;
  embeddings: number[][]; // Array of embedding vectors
}

/** How often to probe primary URL when operating on fallback */
const PRIMARY_PROBE_INTERVAL_MS = 30_000;

/** Event emitted when Ollama switches between primary and fallback URLs. */
export interface FallbackSwitchEvent {
  direction: "to-fallback" | "to-primary";
  primaryUrl: string;
  fallbackUrl: string;
  reason: string;
}

export class OllamaEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly limiter: Bottleneck;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;
  private readonly fallbackBaseUrl?: string;
  private readonly numGpu: number;
  private useNativeBatch: boolean;
  private usingFallback = false;
  private probeTimer?: ReturnType<typeof setInterval>;
  private primaryAlive = false;
  private primaryAliveAt = 0;

  /** Optional callback for fallback switch observability. Set by pipeline wiring. */
  onFallbackSwitch?: (event: FallbackSwitchEvent) => void;

  constructor(
    model = "unclemusclez/jina-embeddings-v2-base-code:latest",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
    baseUrl = "http://localhost:11434",
    legacyApi = false,
    numGpu = 999,
    fallbackBaseUrl?: string,
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.fallbackBaseUrl = fallbackBaseUrl;
    this.numGpu = numGpu;
    // Enable native batch by default unless legacyApi is true
    this.useNativeBatch = !legacyApi;

    this.dimensions = dimensions || getModelDimensions(model) || 768;

    // Rate limiting configuration (more lenient for local models)
    const maxRequestsPerMinute = rateLimitConfig?.maxRequestsPerMinute || 1000;
    this.retryAttempts = rateLimitConfig?.retryAttempts || 3;
    this.retryDelayMs = rateLimitConfig?.retryDelayMs || 500;

    this.limiter = new Bottleneck({
      reservoir: maxRequestsPerMinute,
      reservoirRefreshAmount: maxRequestsPerMinute,
      reservoirRefreshInterval: 60 * 1000,
      maxConcurrent: 10,
      minTime: Math.floor((60 * 1000) / maxRequestsPerMinute),
    });
  }

  private emitFallbackSwitch(direction: FallbackSwitchEvent["direction"], reason: string): void {
    if (this.onFallbackSwitch && this.fallbackBaseUrl) {
      this.onFallbackSwitch({
        direction,
        primaryUrl: this.baseUrl,
        fallbackUrl: this.fallbackBaseUrl,
        reason,
      });
    }
  }

  private isOllamaError(e: unknown): e is OllamaError {
    return typeof e === "object" && e !== null && ("status" in e || "message" in e);
  }

  private isRateLimit(error: unknown): boolean {
    // Check responseStatus on OllamaUnavailableError (from callApi/callBatchApi HTTP errors)
    if (error instanceof OllamaUnavailableError && error.responseStatus === 429) return true;
    // Check OllamaError-shaped objects (from rejected fetch with rate limit message)
    const apiError = this.isOllamaError(error) ? error : { status: 0, message: String(error) };
    return (
      apiError.status === 429 ||
      (typeof apiError.message === "string" && apiError.message.toLowerCase().includes("rate limit"))
    );
  }

  /** Start background probe that pings primary every 30s. On success, switch back. */
  private startPrimaryProbe(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => {
      void this.probePrimary();
    }, PRIMARY_PROBE_INTERVAL_MS);
    // Don't keep process alive just for the probe
    if (this.probeTimer && typeof this.probeTimer === "object" && "unref" in this.probeTimer) {
      this.probeTimer.unref();
    }
  }

  private stopPrimaryProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * Lightweight pre-flight check: GET / with short timeout.
   * Cached for HEALTH_TTL_MS to avoid overhead on warm calls.
   * Only called when fallback is configured — separates "server alive?"
   * (fast, ~15ms) from "embed works?" (slow on cold model, ~2s).
   */
  private async checkPrimaryHealth(): Promise<boolean> {
    if (this.primaryAlive && Date.now() - this.primaryAliveAt < HEALTH_TTL_MS) {
      return true;
    }
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      if (response.ok) {
        this.primaryAlive = true;
        this.primaryAliveAt = Date.now();
        return true;
      }
      this.primaryAlive = false;
      return false;
    } catch {
      this.primaryAlive = false;
      return false;
    }
  }

  private async probePrimary(): Promise<void> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      if (response.ok) {
        this.usingFallback = false;
        this.primaryAlive = true;
        this.primaryAliveAt = Date.now();
        this.stopPrimaryProbe();
        if (isDebug()) {
          console.error(`[Ollama] Primary ${this.baseUrl} recovered, switching back from fallback`);
        }
        this.emitFallbackSwitch("to-primary", "primary recovered (health probe OK)");
      }
    } catch {
      // Still down — probe continues
    }
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, fallbackFn?: () => Promise<T>): Promise<T> {
    // Quick path: if primary is down and fallback available, skip primary entirely
    if (fallbackFn && this.fallbackBaseUrl && this.usingFallback) {
      try {
        return await fallbackFn();
      } catch (fallbackError) {
        if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
        this.usingFallback = false;
        this.stopPrimaryProbe();
        throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl);
      }
    }

    // Health probe: if fallback exists, check primary is alive before attempting embed.
    // This separates "server reachable?" (fast ~15ms via GET /) from
    // "embed works?" (slow ~2s on cold model load). Without this, the 1s embed
    // timeout would always fail on cold starts.
    if (fallbackFn && this.fallbackBaseUrl) {
      const healthy = await this.checkPrimaryHealth();
      if (!healthy) {
        this.usingFallback = true;
        this.startPrimaryProbe();
        if (isDebug()) {
          console.error(`[Ollama] Primary ${this.baseUrl} health probe failed, using fallback ${this.fallbackBaseUrl}`);
        }
        this.emitFallbackSwitch("to-fallback", "primary health probe failed");
        try {
          return await fallbackFn();
        } catch (fallbackError) {
          if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
          this.usingFallback = false;
          this.stopPrimaryProbe();
          throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl);
        }
      }
    }

    try {
      return await withRateLimitRetry(fn, {
        maxAttempts: this.retryAttempts,
        baseDelayMs: this.retryDelayMs,
        isRetryable: (error) => this.isRateLimit(error),
      });
    } catch (primaryError) {
      if (primaryError instanceof OllamaModelMissingError) {
        throw primaryError;
      }

      // Invalidate health cache — primary failed despite probe
      this.primaryAlive = false;

      if (!fallbackFn || !this.fallbackBaseUrl) {
        throw new OllamaUnavailableError(this.baseUrl, primaryError instanceof Error ? primaryError : undefined);
      }

      this.usingFallback = true;
      this.startPrimaryProbe();

      if (isDebug()) {
        console.error(
          `[Ollama] Primary ${this.baseUrl} failed, switching to fallback ${this.fallbackBaseUrl}. Probing primary every ${PRIMARY_PROBE_INTERVAL_MS / 1000}s.`,
        );
      }
      this.emitFallbackSwitch("to-fallback", "primary embed failed");

      try {
        return await fallbackFn();
      } catch (fallbackError) {
        if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
        this.usingFallback = false;
        this.stopPrimaryProbe();
        throw OllamaUnavailableError.withFallback(
          this.baseUrl,
          this.fallbackBaseUrl,
          primaryError instanceof Error ? primaryError : undefined,
        );
      }
    }
  }

  /**
   * NEW: Native batch embedding using /api/embed
   * Sends all texts in ONE request instead of N separate requests
   */
  private async callBatchApi(texts: string[], url?: string, timeoutMs?: number): Promise<OllamaEmbedBatchResponse> {
    const baseUrl = url ?? this.baseUrl;
    const response = await fetchWithTimeout(
      `${baseUrl}/api/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          options: { num_gpu: this.numGpu },
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      /* v8 ignore next 3 -- legacy API 404 path, tested via native batch */
      if (response.status === 404 || errorBody.includes("not found")) {
        throw new OllamaModelMissingError(this.model, baseUrl);
      }
      throw new OllamaUnavailableError(baseUrl, undefined, response.status);
    }

    return response.json() as Promise<OllamaEmbedBatchResponse>;
  }

  /**
   * Legacy single embedding using /api/embeddings
   * Fallback for older Ollama versions
   */
  private async callApi(text: string, url?: string): Promise<OllamaEmbedResponse> {
    const baseUrl = url ?? this.baseUrl;
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
          options: { num_gpu: this.numGpu },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 404 || errorBody.includes("not found")) {
          throw new OllamaModelMissingError(this.model, baseUrl);
        }
        throw new OllamaUnavailableError(baseUrl, undefined, response.status);
      }

      return response.json() as Promise<OllamaEmbedResponse>;
    } catch (error) {
      // Re-throw typed errors (from !response.ok block)
      if (error instanceof OllamaModelMissingError || error instanceof OllamaUnavailableError) {
        throw error;
      }

      // Detect rate limit from rejected fetch (network-level errors with rate limit message)
      const rateLimitStatus =
        this.isOllamaError(error) &&
        typeof error.message === "string" &&
        error.message.toLowerCase().includes("rate limit")
          ? 429
          : undefined;

      // Wrap network errors and unknown errors
      throw new OllamaUnavailableError(baseUrl, error instanceof Error ? error : undefined, rateLimitStatus);
    }
  }

  /** Full request timeout — probe handles fast failover, embed gets full budget. */
  /* v8 ignore next 3 -- timeout constant, exercised via integration tests */
  private connectTimeoutForUrl(_url: string): number {
    return CONNECT_TIMEOUT_MS;
  }

  /** Timeout scaled for batch size — large batches need proportionally more time */
  /* v8 ignore next 5 -- exercised via integration; unit tests use mocked embeddings */
  private batchTimeoutForUrl(url: string, batchSize: number): number {
    const connectTimeout = this.connectTimeoutForUrl(url);
    if (batchSize <= 1) return connectTimeout;
    return Math.max(connectTimeout, BATCH_BASE_TIMEOUT_MS + batchSize * BATCH_PER_ITEM_TIMEOUT_MS);
  }

  private async embedSingle(text: string, url: string): Promise<EmbeddingResult> {
    return (async () => {
      if (this.useNativeBatch) {
        const response = await this.callBatchApi([text], url, this.connectTimeoutForUrl(url));
        if (!response.embeddings || response.embeddings.length === 0) {
          throw new OllamaUnavailableError(url);
        }
        return { embedding: response.embeddings[0], dimensions: this.dimensions };
      }
      const response = await this.callApi(text, url);
      if (!response.embedding) {
        throw new OllamaUnavailableError(url);
      }
      return { embedding: response.embedding, dimensions: this.dimensions };
    })();
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(
        async () => this.embedSingle(text, this.baseUrl),
        this.fallbackBaseUrl ? async () => this.embedSingle(text, this.fallbackBaseUrl as string) : undefined,
      ),
    );
  }

  /**
   * OPTIMIZED: Native batch embeddings
   *
   * OLD: N texts → N HTTP requests (even with Promise.all, still N requests!)
   * NEW: N texts → 1 HTTP request with input array
   *
   * Performance: ~50-100x less network overhead
   *
   * Batch size configurable via EMBEDDING_BATCH_SIZE env var:
   * - 0 = use single requests with INGEST_PIPELINE_CONCURRENCY (fallback mode)
   * - 32 = conservative (recommended for limited VRAM)
   * - 64 = balanced (default, good for 8GB+ VRAM)
   * - 128-512 = aggressive (for high-end GPUs)
   * - 2048+ = benchmark showed linear scaling with AMD 12GB GPU
   *
   * Note: GPU must have num_gpu: 999 enabled (see callBatchApi)
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // Batch size is controlled by pipeline accumulator (EMBEDDING_BATCH_SIZE env).
    // This method sends ALL received texts in a single API call.

    // Use native batch API - ONE request for ALL texts
    if (this.useNativeBatch) {
      const batchEmbed = async (url: string): Promise<EmbeddingResult[]> => {
        const timeout = this.batchTimeoutForUrl(url, texts.length);
        if (isDebug()) {
          console.error(`[Ollama] Native batch: ${texts.length} texts in 1 request to ${url} (timeout=${timeout}ms)`);
        }
        const response = await this.callBatchApi(texts, url, timeout);
        if (response.embeddings?.length !== texts.length) {
          throw new OllamaUnavailableError(url);
        }
        return response.embeddings.map((embedding: number[]) => ({
          embedding,
          dimensions: this.dimensions,
        }));
      };

      return this.limiter.schedule(async () =>
        this.retryWithBackoff(
          async () => batchEmbed(this.baseUrl),
          /* v8 ignore next -- batch fallback exercised via integration tests */
          this.fallbackBaseUrl ? async () => batchEmbed(this.fallbackBaseUrl as string) : undefined,
        ),
      );
    }

    // Fallback: Legacy parallel individual requests (old Ollama without /api/embed)
    if (isDebug()) {
      console.error(`[Ollama] Fallback: ${texts.length} individual requests`);
    }
    const results: EmbeddingResult[] = [];

    for (const text of texts) {
      results.push(await this.embed(text));
    }

    return results;
  }

  /**
   * Check if Ollama supports native batch API
   * Can be used to auto-detect and fallback
   */
  async checkBatchSupport(): Promise<boolean> {
    try {
      const response = await this.callBatchApi(["test"]);
      return !!response.embeddings;
    } catch {
      console.error("[Ollama] Native batch not supported, using fallback");
      this.useNativeBatch = false;
      return false;
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  async checkHealth(): Promise<boolean> {
    const url = this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
    try {
      const response = await fetchWithTimeout(`${url}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      return response.ok;
    } catch {
      return false;
    }
  }

  getProviderName(): string {
    return "ollama";
  }

  getBaseUrl(): string {
    return this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
  }
}
