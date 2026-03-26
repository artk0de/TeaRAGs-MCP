import Bottleneck from "bottleneck";
import { CohereClient } from "cohere-ai";

import type { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";
import { CohereApiError, CohereRateLimitError } from "./cohere/errors.js";
import { withRateLimitRetry } from "./retry.js";
import { getModelDimensions } from "./utils/model-dimensions.js";

interface CohereError {
  status?: number;
  statusCode?: number;
  message?: string;
}

function isCohereRateLimit(error: unknown): boolean {
  const apiError = error as CohereError;
  return (
    apiError?.status === 429 ||
    apiError?.statusCode === 429 ||
    apiError?.message?.toLowerCase().includes("rate limit") === true
  );
}

export class CohereEmbeddings implements EmbeddingProvider {
  private readonly client: CohereClient;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly limiter: Bottleneck;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly inputType: "search_document" | "search_query" | "classification" | "clustering";

  constructor(
    apiKey: string,
    model = "embed-english-v3.0",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
    inputType: "search_document" | "search_query" | "classification" | "clustering" = "search_document",
  ) {
    this.client = new CohereClient({ token: apiKey });
    this.model = model;
    this.inputType = inputType;

    this.dimensions = dimensions || getModelDimensions(model) || 1024;

    // Rate limiting configuration
    const maxRequestsPerMinute = rateLimitConfig?.maxRequestsPerMinute || 100;
    this.retryAttempts = rateLimitConfig?.retryAttempts || 3;
    this.retryDelayMs = rateLimitConfig?.retryDelayMs || 1000;

    this.limiter = new Bottleneck({
      reservoir: maxRequestsPerMinute,
      reservoirRefreshAmount: maxRequestsPerMinute,
      reservoirRefreshInterval: 60 * 1000,
      maxConcurrent: 5,
      minTime: Math.floor((60 * 1000) / maxRequestsPerMinute),
    });
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withRateLimitRetry(fn, {
        maxAttempts: this.retryAttempts,
        baseDelayMs: this.retryDelayMs,
        isRetryable: isCohereRateLimit,
      });
    } catch (error) {
      if (isCohereRateLimit(error)) {
        throw new CohereRateLimitError(error instanceof Error ? error : undefined);
      }
      const cause = error instanceof Error ? error : undefined;
      throw new CohereApiError(cause?.message ?? String(error), cause);
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(async () => {
        const response = await this.client.embed({
          texts: [text],
          model: this.model,
          inputType: this.inputType,
          embeddingTypes: ["float"],
        });

        // Cohere v7+ returns embeddings as number[][]
        const embeddings = response.embeddings as number[][];
        if (!embeddings || embeddings.length === 0) {
          throw new CohereApiError("No embedding returned from Cohere API");
        }

        return {
          embedding: embeddings[0],
          dimensions: this.dimensions,
        };
      }),
    );
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(async () => {
        const response = await this.client.embed({
          texts,
          model: this.model,
          inputType: this.inputType,
          embeddingTypes: ["float"],
        });

        // Cohere v7+ returns embeddings as number[][]
        const embeddings = response.embeddings as number[][];
        if (!embeddings) {
          throw new CohereApiError("No embeddings returned from Cohere API");
        }

        return embeddings.map((embedding: number[]) => ({
          embedding,
          dimensions: this.dimensions,
        }));
      }),
    );
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  async checkHealth(): Promise<boolean> {
    return true;
  }

  getProviderName(): string {
    return "cohere";
  }
}
