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
import {
  OllamaContextOverflowError,
  OllamaModelMissingError,
  OllamaResponseError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from "./ollama/errors.js";
import { parseModelInfo, type OllamaModelInfo } from "./ollama/model-info.js";
import { withRateLimitRetry } from "./retry.js";
import { getModelDimensions } from "./utils/model-dimensions.js";

/** Full request timeout for single embed calls (connect + model load + inference).
 *  30s allows for cold model loads after successful health check. */
const SINGLE_EMBED_TIMEOUT_MS = 30_000;
/** Timeout for lightweight health probe (GET /) */
const HEALTH_PROBE_TIMEOUT_MS = 1000;
/** Minimum time after primary failure before allowing recovery */
const RECOVERY_COOLDOWN_MS = 60_000;
/**
 * Per-item timeout budget for batch requests.
 * Total timeout = BATCH_PER_ITEM_TIMEOUT_MS × batchSize + BATCH_BASE_TIMEOUT_MS.
 * Ollama processes batches synchronously — large batches need proportionally more time.
 */
const BATCH_BASE_TIMEOUT_MS = 30_000; // 30s base (model loading, warmup)
const BATCH_PER_ITEM_TIMEOUT_MS = 200; // 200ms per item (accounts for GPU queue with concurrent workers)

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = SINGLE_EMBED_TIMEOUT_MS,
): Promise<Response> {
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

/** Detect "input length exceeds context" error from Ollama response body. */
function isContextOverflow(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("context length") || lower.includes("input length");
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
  private readonly primaryFailedAt = 0;
  private cachedModelInfo?: OllamaModelInfo;

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

    if (fallbackBaseUrl) {
      void this.checkInitialHealth();
    }
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
    // Check responseStatus on OllamaResponseError (HTTP 429 from Ollama)
    if (error instanceof OllamaResponseError && error.responseStatus === 429) return true;
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

  private async checkInitialHealth(): Promise<void> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      if (!response.ok) {
        this.switchToFallback("initial health check non-ok");
      } else {
        this.primaryAlive = true;
        this.primaryAliveAt = Date.now();
      }
    } catch {
      this.switchToFallback("initial health check failed");
    }
  }

  private switchToFallback(reason: string): void {
    this.usingFallback = true;
    this.primaryAlive = false;
    this.startPrimaryProbe();
    if (isDebug()) {
      console.error(`[Ollama] ${reason}, using fallback ${this.fallbackBaseUrl}`);
    }
    this.emitFallbackSwitch("to-fallback", reason);
  }

  private async probePrimary(): Promise<void> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" }, HEALTH_PROBE_TIMEOUT_MS);
      if (response.ok) {
        if (Date.now() - this.primaryFailedAt < RECOVERY_COOLDOWN_MS) {
          return;
        }
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

  /** Return current active URL without health checks (no-fallback path). */
  private resolveActiveUrl(): string {
    return this.usingFallback && this.fallbackBaseUrl ? this.fallbackBaseUrl : this.baseUrl;
  }

  private async retryWithBackoff<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const url = this.resolveActiveUrl();
    try {
      return await withRateLimitRetry(async () => fn(url), {
        maxAttempts: this.retryAttempts,
        baseDelayMs: this.retryDelayMs,
        isRetryable: (error) => this.isRateLimit(error),
      });
    } catch (error) {
      // Typed errors propagate directly — no fallback switching
      if (error instanceof OllamaModelMissingError) throw error;
      if (error instanceof OllamaTimeoutError) throw error;
      if (error instanceof OllamaResponseError) throw error;

      // Connection/HTTP errors: propagate with cause, no fallback switch.
      // Fallback is only decided at initial health check (constructor), not mid-operation.
      const cause = error instanceof Error ? error : undefined;

      if (this.usingFallback && this.fallbackBaseUrl) {
        throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl, cause);
      }

      throw new OllamaUnavailableError(url, cause);
    }
  }

  /**
   * NEW: Native batch embedding using /api/embed
   * Sends all texts in ONE request instead of N separate requests
   */
  private async callBatchApi(texts: string[], url?: string, timeoutMs?: number): Promise<OllamaEmbedBatchResponse> {
    const baseUrl = url ?? this.baseUrl;
    const effectiveTimeout = timeoutMs ?? this.batchTimeout(texts.length);

    // Own AbortController with timedOut flag — distinguishes our timeout from other aborts
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          options: { num_gpu: this.numGpu },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new OllamaTimeoutError(
          baseUrl,
          texts.length,
          effectiveTimeout,
          error instanceof Error ? error : undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      /* v8 ignore next 3 -- legacy API 404 path, tested via native batch */
      if (response.status === 404 || errorBody.includes("not found")) {
        throw new OllamaModelMissingError(this.model, baseUrl);
      }
      if (isContextOverflow(errorBody)) {
        throw new OllamaContextOverflowError(baseUrl, response.status, errorBody);
      }
      throw new OllamaResponseError(baseUrl, response.status, errorBody);
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
        if (isContextOverflow(errorBody)) {
          throw new OllamaContextOverflowError(baseUrl, response.status, errorBody);
        }
        throw new OllamaResponseError(baseUrl, response.status, errorBody);
      }

      return response.json() as Promise<OllamaEmbedResponse>;
    } catch (error) {
      // Re-throw typed errors (from !response.ok block)
      if (error instanceof OllamaModelMissingError || error instanceof OllamaResponseError) {
        throw error;
      }

      // Detect rate limit from network-level rejection (raw error with rate limit message)
      const rawMessage = this.isOllamaError(error) ? error.message : undefined;
      if (
        (this.isOllamaError(error) && error.status === 429) ||
        (typeof rawMessage === "string" && rawMessage.toLowerCase().includes("rate limit"))
      ) {
        throw new OllamaResponseError(baseUrl, 429, rawMessage ?? "rate limited");
      }

      // Network errors → server unavailable
      throw new OllamaUnavailableError(baseUrl, error instanceof Error ? error : undefined);
    }
  }

  /** Full request timeout — probe handles fast failover, embed gets full budget. */
  /* v8 ignore next 3 -- timeout constant, exercised via integration tests */
  private singleEmbedTimeout(): number {
    return SINGLE_EMBED_TIMEOUT_MS;
  }

  /** Timeout scaled for batch size — large batches need proportionally more time */
  /* v8 ignore next 5 -- exercised via integration; unit tests use mocked embeddings */
  private batchTimeout(batchSize: number): number {
    const singleTimeout = this.singleEmbedTimeout();
    if (batchSize <= 1) return singleTimeout;
    return Math.max(singleTimeout, BATCH_BASE_TIMEOUT_MS + batchSize * BATCH_PER_ITEM_TIMEOUT_MS);
  }

  private async embedSingle(text: string, url: string): Promise<EmbeddingResult> {
    if (this.useNativeBatch) {
      const response = await this.callBatchApi([text], url, this.singleEmbedTimeout());
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
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(async () => this.retryWithBackoff(async (url) => this.embedSingle(text, url)));
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
        const timeout = this.batchTimeout(texts.length);
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

      return this.limiter.schedule(async () => this.retryWithBackoff(async (url) => batchEmbed(url)));
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

  async resolveModelInfo(): Promise<OllamaModelInfo | undefined> {
    if (this.cachedModelInfo) return this.cachedModelInfo;

    const url = this.resolveActiveUrl();
    try {
      const response = await fetchWithTimeout(
        `${url}/api/show`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.model }),
        },
        HEALTH_PROBE_TIMEOUT_MS * 5,
      );
      if (!response.ok) return undefined;

      const data = (await response.json()) as { model_info?: Record<string, unknown> };
      if (!data.model_info) return undefined;

      const info = parseModelInfo(this.model, data.model_info);
      if (info) this.cachedModelInfo = info;
      return info;
    } catch {
      return undefined;
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
