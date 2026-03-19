import Bottleneck from "bottleneck";
import OpenAI from "openai";

import type { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";
import { OpenAIAuthError, OpenAIRateLimitError } from "./openai/errors.js";
import { withRateLimitRetry } from "./retry.js";
import { getModelDimensions } from "./utils/model-dimensions.js";

interface OpenAIError {
  status?: number;
  code?: string;
  message?: string;
  headers?: Record<string, string>;
  response?: {
    headers?: Record<string, string>;
  };
}

function isOpenAIRateLimit(error: unknown): boolean {
  const apiError = error as OpenAIError;
  return (
    apiError?.status === 429 ||
    apiError?.code === "rate_limit_exceeded" ||
    apiError?.message?.toLowerCase().includes("rate limit") === true
  );
}

function getOpenAIRetryAfterMs(error: unknown): number | undefined {
  const apiError = error as OpenAIError;
  const retryAfter = apiError?.response?.headers?.["retry-after"] || apiError?.headers?.["retry-after"];
  if (!retryAfter) return undefined;
  const parsed = parseInt(retryAfter, 10);
  return !isNaN(parsed) && parsed > 0 ? parsed * 1000 : undefined;
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly limiter: Bottleneck;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    apiKey: string,
    model = "text-embedding-3-small",
    dimensions?: number,
    rateLimitConfig?: RateLimitConfig,
  ) {
    this.client = new OpenAI({ apiKey });
    this.model = model;

    this.dimensions = dimensions || getModelDimensions(model) || 1536;

    // Rate limiting configuration
    const maxRequestsPerMinute = rateLimitConfig?.maxRequestsPerMinute || 3500;
    this.retryAttempts = rateLimitConfig?.retryAttempts || 3;
    this.retryDelayMs = rateLimitConfig?.retryDelayMs || 1000;

    // Initialize bottleneck limiter
    // Uses reservoir (token bucket) pattern for burst handling with per-minute refresh
    // Note: Using both reservoir and minTime provides defense in depth but may be
    // more conservative than necessary. Future optimization could use reservoir-only
    // for better burst handling or minTime-only for simpler even distribution.
    this.limiter = new Bottleneck({
      reservoir: maxRequestsPerMinute,
      reservoirRefreshAmount: maxRequestsPerMinute,
      reservoirRefreshInterval: 60 * 1000, // 1 minute
      maxConcurrent: 10,
      minTime: Math.floor((60 * 1000) / maxRequestsPerMinute),
    });
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withRateLimitRetry(fn, {
        maxAttempts: this.retryAttempts,
        baseDelayMs: this.retryDelayMs,
        isRetryable: isOpenAIRateLimit,
        getRetryAfterMs: getOpenAIRetryAfterMs,
      });
    } catch (error) {
      if (isOpenAIRateLimit(error)) {
        throw new OpenAIRateLimitError(error instanceof Error ? error : undefined);
      }
      const apiError = error as OpenAIError;
      if (apiError?.status === 401 || apiError?.status === 403) {
        throw new OpenAIAuthError(error instanceof Error ? error : undefined);
      }
      throw error;
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return this.limiter.schedule(async () =>
      this.retryWithBackoff(async () => {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: text,
          dimensions: this.dimensions,
        });

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
        const response = await this.client.embeddings.create({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        });

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
}
