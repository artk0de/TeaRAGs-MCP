/**
 * Ollama embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class OllamaUnavailableError extends EmbeddingError {
  /** HTTP response status from Ollama API (e.g. 429 for rate limit). Undefined for network errors. */
  readonly responseStatus?: number;

  constructor(url: string, cause?: Error, responseStatus?: number) {
    super({
      code: "INFRA_OLLAMA_UNAVAILABLE",
      message: `Ollama is not reachable at ${url}`,
      hint: `Start Ollama: ollama serve, or verify OLLAMA_URL=${url}`,
      httpStatus: 503,
      cause,
    });
    this.responseStatus = responseStatus;
  }

  /** Create error when both primary and fallback URLs are unreachable. */
  static withFallback(primaryUrl: string, fallbackUrl: string, cause?: Error): OllamaUnavailableError {
    const hasLocal = isLocalUrl(primaryUrl) || isLocalUrl(fallbackUrl);
    const hint = hasLocal
      ? `Start Ollama locally: ollama serve — or check connectivity to ${primaryUrl} and ${fallbackUrl}`
      : `Check network connectivity to ${primaryUrl} and ${fallbackUrl}`;

    const error = new OllamaUnavailableError(primaryUrl, cause);
    // Override message and hint via the base class fields
    Object.defineProperty(error, "message", {
      value: `Ollama is not reachable at ${primaryUrl} (primary) or ${fallbackUrl} (fallback)`,
    });
    Object.defineProperty(error, "hint", { value: hint });
    return error;
  }
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "192.168.1.1";
  } catch {
    return false;
  }
}

export class OllamaModelMissingError extends EmbeddingError {
  constructor(model: string, url: string) {
    super({
      code: "INFRA_OLLAMA_MODEL_MISSING",
      message: `Ollama model "${model}" is not available at ${url}`,
      hint: `Pull the model: ollama pull ${model}`,
      httpStatus: 503,
    });
  }
}
