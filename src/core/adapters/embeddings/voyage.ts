import Bottleneck from "bottleneck";

import type { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";
import { withRateLimitRetry } from "./retry.js";
import { getModelDimensions } from "./utils/model-dimensions.js";
import { VoyageApiError, VoyageRateLimitError } from "./voyage/errors.js";

interface VoyageError {
  status?: number;
  message?: string;
}

function isVoyageRateLimit(error: unknown): boolean {
  const apiError = error as VoyageError;
  return apiError?.status === 429 || apiError?.message?.toLowerCase().includes("rate limit") === true;
}

interface VoyageEmbedResponse {
  data: { embedding: number[] }[];
  model: string;
  usage: {
    total_tokens: number;
  };
}

export class VoyageEmbeddings implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly limiter: Bottleneck;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;
  private readonly inputType?: "query" | "document";

  constructor(
    apiKey: string,
    model = "voyage-2",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
    baseUrl = "https://api.voyageai.com/v1",
    inputType?: "query" | "document",
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.inputType = inputType;

    this.dimensions = dimensions || getModelDimensions(model) || 1024;

    // Rate limiting configuration
    const maxRequestsPerMinute = rateLimitConfig?.maxRequestsPerMinute || 300;
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
        isRetryable: isVoyageRateLimit,
      });
    } catch (error) {
      if (isVoyageRateLimit(error)) {
        throw new VoyageRateLimitError(error instanceof Error ? error : undefined);
      }
      const cause = error instanceof Error ? error : undefined;
      throw new VoyageApiError(cause?.message ?? String(error), cause);
    }
  }

  private async callApi(texts: string[]): Promise<VoyageEmbedResponse> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };

    if (this.inputType) {
      body.input_type = this.inputType;
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new VoyageApiError(`(${response.status}): ${errorText}`);
    }

    return response.json() as Promise<VoyageEmbedResponse>;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(async () => {
        const response = await this.callApi([text]);

        if (!response.data || response.data.length === 0) {
          throw new VoyageApiError("No embedding returned from Voyage AI API");
        }

        return {
          embedding: response.data[0].embedding,
          dimensions: this.dimensions,
        };
      }),
    );
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(async () => {
        const response = await this.callApi(texts);

        if (!response.data) {
          throw new VoyageApiError("No embeddings returned from Voyage AI API");
        }

        return response.data.map((item) => ({
          embedding: item.embedding,
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
    return "voyage";
  }
}
