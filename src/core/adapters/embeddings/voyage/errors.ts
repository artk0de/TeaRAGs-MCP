/**
 * Voyage embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class VoyageRateLimitError extends EmbeddingError {
  constructor(cause?: Error) {
    super({
      code: "INFRA_VOYAGE_RATE_LIMIT",
      message: "Voyage API rate limit exceeded",
      hint: "Wait and retry, or check your Voyage plan limits",
      httpStatus: 429,
      cause,
    });
  }
}

export class VoyageApiError extends EmbeddingError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INFRA_VOYAGE_API",
      message: `Voyage AI API error: ${detail}`,
      hint: "Check Voyage AI API status and configuration",
      httpStatus: 502,
      cause,
    });
  }
}
