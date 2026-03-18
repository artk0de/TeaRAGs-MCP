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
