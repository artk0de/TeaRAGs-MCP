/**
 * OpenAI embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class OpenAIRateLimitError extends EmbeddingError {
  constructor(cause?: Error) {
    super({
      code: "INFRA_OPENAI_RATE_LIMIT",
      message: "OpenAI API rate limit exceeded",
      hint: "Wait and retry, or check your OpenAI plan limits",
      httpStatus: 429,
      cause,
    });
  }
}

export class OpenAIAuthError extends EmbeddingError {
  constructor(cause?: Error) {
    super({
      code: "INFRA_OPENAI_AUTH_FAILED",
      message: "OpenAI API authentication failed",
      hint: "Verify your OPENAI_API_KEY is set and valid",
      httpStatus: 401,
      cause,
    });
  }
}
