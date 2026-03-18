/**
 * Cohere embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class CohereRateLimitError extends EmbeddingError {
  constructor(cause?: Error) {
    super({
      code: "INFRA_COHERE_RATE_LIMIT",
      message: "Cohere API rate limit exceeded",
      hint: "Wait and retry, or check your Cohere plan limits",
      httpStatus: 429,
      cause,
    });
  }
}

export class CohereApiError extends EmbeddingError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INFRA_COHERE_API",
      message: `Cohere API error: ${detail}`,
      hint: "Check Cohere API status and configuration",
      httpStatus: 502,
      cause,
    });
  }
}
