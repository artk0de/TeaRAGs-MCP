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
import { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";

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
  embeddings: number[][];  // Array of embedding vectors
}

export class OllamaEmbeddings implements EmbeddingProvider {
  private model: string;
  private dimensions: number;
  private limiter: Bottleneck;
  private retryAttempts: number;
  private retryDelayMs: number;
  private baseUrl: string;
  private useNativeBatch: boolean;

  constructor(
    model: string = "unclemusclez/jina-embeddings-v2-base-code:latest",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
    baseUrl: string = "http://localhost:11434",
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
    // Enable native batch by default unless OLLAMA_LEGACY_API=true (for tests)
    this.useNativeBatch = process.env.OLLAMA_LEGACY_API !== "true";

    // Default dimensions for different models
    const defaultDimensions: Record<string, number> = {
      "nomic-embed-text": 768,
      "mxbai-embed-large": 1024,
      "all-minilm": 384,
      "jina-embeddings-v2-base-code": 768,
      "unclemusclez/jina-embeddings-v2-base-code:latest": 768,
    };

    this.dimensions = dimensions || defaultDimensions[model] || 768;

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
    return (
      typeof e === "object" && e !== null && ("status" in e || "message" in e)
    );
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    attempt: number = 0,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      // Type guard for OllamaError
      const apiError = this.isOllamaError(error)
        ? error
        : { status: 0, message: String(error) };

      const isRateLimitError =
        apiError.status === 429 ||
        (typeof apiError.message === "string" &&
          apiError.message.toLowerCase().includes("rate limit"));

      if (isRateLimitError && attempt < this.retryAttempts) {
        const delayMs = this.retryDelayMs * Math.pow(2, attempt);
        const waitTimeSeconds = (delayMs / 1000).toFixed(1);
        console.error(
          `Rate limit reached. Retrying in ${waitTimeSeconds}s (attempt ${attempt + 1}/${this.retryAttempts})...`,
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.retryWithBackoff(fn, attempt + 1);
      }

      if (isRateLimitError) {
        throw new Error(
          `Ollama API rate limit exceeded after ${this.retryAttempts} retry attempts. Please try again later or reduce request frequency.`,
        );
      }

      throw error;
    }
  }

  /**
   * NEW: Native batch embedding using /api/embed
   * Sends all texts in ONE request instead of N separate requests
   */
  private async callBatchApi(texts: string[]): Promise<OllamaEmbedBatchResponse> {
    // Configurable GPU usage: 0 = CPU only, 999 = all layers on GPU
    const numGpu = process.env.OLLAMA_NUM_GPU
      ? parseInt(process.env.OLLAMA_NUM_GPU, 10)
      : 999;

    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,  // Array of texts!
        options: {
          num_gpu: numGpu,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw {
        status: response.status,
        message: `Ollama batch API error (${response.status}): ${errorBody}`,
      } as OllamaError;
    }

    return response.json();
  }

  /**
   * Legacy single embedding using /api/embeddings
   * Fallback for older Ollama versions
   */
  private async callApi(text: string): Promise<OllamaEmbedResponse> {
    // Configurable GPU usage: 0 = CPU only, 999 = all layers on GPU
    const numGpu = process.env.OLLAMA_NUM_GPU
      ? parseInt(process.env.OLLAMA_NUM_GPU, 10)
      : 999;

    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
          options: {
            num_gpu: numGpu,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const textPreview =
          text.length > 100 ? text.substring(0, 100) + "..." : text;
        const error: OllamaError = {
          status: response.status,
          message: `Ollama API error (${response.status}) for model "${this.model}": ${errorBody}. Text preview: "${textPreview}"`,
        };
        throw error;
      }

      return response.json();
    } catch (error) {
      // Re-throw if it's already an OllamaError from the !response.ok block
      if (error && typeof error === "object" && "status" in error) {
        throw error;
      }

      // For Error instances (like network errors), enhance the message
      if (error instanceof Error) {
        const textPreview =
          text.length > 100 ? text.substring(0, 100) + "..." : text;
        throw new Error(
          `Failed to call Ollama API at ${this.baseUrl} with model ${this.model}: ${error.message}. Text preview: "${textPreview}"`,
        );
      }

      // Handle objects with 'message' property - preserve the original error structure
      // This ensures objects with 'message' property work correctly in tests
      if (this.isOllamaError(error)) {
        throw error;
      }

      // For other types, create a descriptive error message
      const textPreview =
        text.length > 100 ? text.substring(0, 100) + "..." : text;
      const errorMessage = JSON.stringify(error);

      throw new Error(
        `Failed to call Ollama API at ${this.baseUrl} with model ${this.model}: ${errorMessage}. Text preview: "${textPreview}"`,
      );
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(() =>
      this.retryWithBackoff(async () => {
        // Use batch API even for single text (more efficient API path)
        if (this.useNativeBatch) {
          const response = await this.callBatchApi([text]);
          if (!response.embeddings || response.embeddings.length === 0) {
            throw new Error("No embeddings returned from Ollama API");
          }
          return {
            embedding: response.embeddings[0],
            dimensions: this.dimensions,
          };
        }

        // Fallback to legacy API
        const response = await this.callApi(text);

        if (!response.embedding) {
          throw new Error("No embedding returned from Ollama API");
        }

        return {
          embedding: response.embedding,
          dimensions: this.dimensions,
        };
      }),
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
   * - 0 = use single requests with EMBEDDING_CONCURRENCY (fallback mode)
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

    // Check batch size setting
    const envBatchSize = process.env.EMBEDDING_BATCH_SIZE;
    const configuredBatchSize = envBatchSize
      ? parseInt(envBatchSize, 10)
      : 64;

    // EMBEDDING_BATCH_SIZE=0 means: use single requests with concurrency
    // This can be faster on CPU (num_gpu=0) than batch API
    if (configuredBatchSize === 0) {
      const envConcurrency = process.env.EMBEDDING_CONCURRENCY;
      const concurrency = envConcurrency ? parseInt(envConcurrency, 10) : 1;

      if (process.env.DEBUG) {
        console.error(
          `[Ollama] Single requests mode: ${texts.length} texts with concurrency=${concurrency}`,
        );
      }

      // Process texts in groups with concurrency
      const results: EmbeddingResult[] = [];
      for (let i = 0; i < texts.length; i += concurrency) {
        const group = texts.slice(i, i + concurrency);
        const groupResults = await Promise.all(
          group.map((text) => this.embed(text)),
        );
        results.push(...groupResults);
      }
      return results;
    }

    // Use native batch API - ONE request for ALL texts (in chunks)
    if (this.useNativeBatch) {
      return this.limiter.schedule(() =>
        this.retryWithBackoff(async () => {
          const MAX_BATCH_SIZE = configuredBatchSize;

          // Configurable concurrency for parallel batch processing
          // Default: 1 (sequential - single Ollama instance)
          // Higher values useful for multiple Ollama instances or external APIs
          const envConcurrency = process.env.EMBEDDING_CONCURRENCY;
          const concurrency = envConcurrency ? parseInt(envConcurrency, 10) : 1;

          // Split texts into batches
          const batches: string[][] = [];
          for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
            batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
          }

          if (process.env.DEBUG) {
            console.error(
              `[Ollama] Processing ${batches.length} batches with concurrency=${concurrency}`,
            );
          }

          // Process batches with concurrency control
          const allResults: EmbeddingResult[][] = [];

          for (let i = 0; i < batches.length; i += concurrency) {
            const batchGroup = batches.slice(i, i + concurrency);

            const groupResults = await Promise.all(
              batchGroup.map(async (batch) => {
                if (process.env.DEBUG) {
                  console.error(
                    `[Ollama] Native batch: ${batch.length} texts in 1 request`,
                  );
                }
                const response = await this.callBatchApi(batch);

                if (
                  !response.embeddings ||
                  response.embeddings.length !== batch.length
                ) {
                  throw new Error(
                    `Ollama returned ${response.embeddings?.length || 0} embeddings for ${batch.length} texts`,
                  );
                }

                return response.embeddings.map((embedding: number[]) => ({
                  embedding,
                  dimensions: this.dimensions,
                }));
              }),
            );

            allResults.push(...groupResults);
          }

          // Flatten results maintaining order
          return allResults.flat();
        }),
      );
    }

    // Fallback: Legacy parallel individual requests
    if (process.env.DEBUG) {
      console.error(`[Ollama] Fallback: ${texts.length} individual requests`);
    }
    const CHUNK_SIZE = 50;
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CHUNK_SIZE);
      // The Bottleneck limiter will handle rate limiting and concurrency (maxConcurrent: 10)
      const chunkResults = await Promise.all(
        chunk.map((text) => this.embed(text)),
      );
      results.push(...chunkResults);
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
