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
 *
 * `hint` is overridable because the default one assumes the NAMES differ: its
 * first option is "point EMBEDDING_MODEL back at <expected>". When the guard
 * catches a model that kept its name and changed its weights, expected equals
 * what the config already says, and that option is a no-op — the caller passes
 * the advice that actually applies.
 */
export class EmbeddingModelMismatchError extends EmbeddingError {
  constructor(expected: string, actual: string, hint?: string) {
    super({
      code: "INFRA_EMBEDDING_MODEL_MISMATCH",
      message: `Embedding model mismatch: collection indexed with "${expected}", current config uses "${actual}"`,
      hint:
        hint ??
        `Either:\n` +
          `1. Fix EMBEDDING_MODEL in config to "${expected}"\n` +
          `2. Force re-index: index_codebase with forceReindex=true`,
      httpStatus: 409,
    });
  }
}
