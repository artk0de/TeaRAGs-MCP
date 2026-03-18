/**
 * Ollama embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class OllamaUnavailableError extends EmbeddingError {
  constructor(url: string, cause?: Error) {
    super({
      code: "INFRA_OLLAMA_UNAVAILABLE",
      message: `Ollama is not reachable at ${url}`,
      hint: `Start Ollama: ollama serve, or verify OLLAMA_URL=${url}`,
      httpStatus: 503,
      cause,
    });
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
