/**
 * Abstract base for all embedding provider errors.
 */

import { InfraError } from "../errors.js";

/**
 * Abstract base class for embedding provider errors.
 * All provider-specific errors (Ollama, ONNX, OpenAI, etc.) extend this.
 */
export abstract class EmbeddingError extends InfraError {}
