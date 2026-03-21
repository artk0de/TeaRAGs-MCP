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

  private async retryWithBackoff<T>(fn: () => Promise<T>, fallbackFn?: () => Promise<T>): Promise<T> {
    try {
      return await withRateLimitRetry(fn, {
        maxAttempts: this.retryAttempts,
        baseDelayMs: this.retryDelayMs,
        isRetryable: (error) => this.isRateLimit(error),
      });
    } catch (primaryError) {
      if (!fallbackFn || !this.fallbackBaseUrl) {
        throw new OllamaUnavailableError(this.baseUrl, primaryError instanceof Error ? primaryError : undefined);
      }

      if (isDebug()) {
        console.error(`[Ollama] Primary ${this.baseUrl} failed, trying fallback ${this.fallbackBaseUrl}`);
      }

      try {
        return await fallbackFn();
      } catch (_fallbackError) {
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
  private async callBatchApi(texts: string[], url?: string): Promise<OllamaEmbedBatchResponse> {
    const baseUrl = url ?? this.baseUrl;
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts, // Array of texts!
        options: {
          num_gpu: this.numGpu,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
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
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
          options: {
            num_gpu: this.numGpu,
          },
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

  private async embedSingle(text: string, url: string): Promise<EmbeddingResult> {
    return (async () => {
      if (this.useNativeBatch) {
        const response = await this.callBatchApi([text], url);
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
        if (isDebug()) {
          console.error(`[Ollama] Native batch: ${texts.length} texts in 1 request to ${url}`);
        }
        const response = await this.callBatchApi(texts, url);
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
}
