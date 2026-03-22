/**
 * Abstract base for all embedding provider errors.
 */

import { InfraError } from "../errors.js";

/**
 * Abstract base class for embedding provider errors.
 * All provider-specific errors (Ollama, ONNX, OpenAI, etc.) extend this.
 */
export abstract class EmbeddingError extends InfraError {}

/**
 * Collection was indexed with a different embedding model than currently configured.
 * Vectors from different models are incompatible — search results will be incorrect.
 */
export class EmbeddingModelMismatchError extends EmbeddingError {
  constructor(expected: string, actual: string) {
    super({
      code: "INFRA_EMBEDDING_MODEL_MISMATCH",
      message: `Embedding model mismatch: collection indexed with "${expected}", current config uses "${actual}"`,
      hint:
        `Either:\n` +
        `1. Fix EMBEDDING_MODEL in config to "${expected}"\n` +
        `2. Force re-index: index_codebase with forceReindex=true`,
      httpStatus: 409,
    });
  }
}
