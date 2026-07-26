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
 *
 * Defined in `infra/errors.ts` because `EmbeddingModelGuard` — the only thrower —
 * lives in the foundation, which may not import `adapters`. Re-exported here so
 * embedding-side consumers keep their import path.
 */
export { EmbeddingModelMismatchError } from "../../infra/errors.js";
