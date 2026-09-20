/**
 * Abstract base for all infrastructure/adapter errors.
 *
 * Covers Qdrant, embeddings, git CLI — anything outside the core domain
 * that can fail due to external service unavailability.
 */

import { TeaRagsError } from "../infra/errors.js";

/**
 * Every infrastructure error code, at runtime — `InfraErrorCode` is derived
 * from it. Concrete InfraError subclasses live in
 * adapters/{qdrant,embeddings,vcs,duckdb}/errors.ts and
 * domains/maintenance/registry/errors.ts. `InfraError`'s constructor takes only
 * these, and `tests/core/adapters/infra-error-codes.test.ts` holds the list to
 * the codes those classes declare in both directions — a code added to a class
 * and not here, or left here after its class is gone, fails.
 */
export const INFRA_ERROR_CODES = [
  // Qdrant
  "INFRA_QDRANT_UNAVAILABLE",
  "INFRA_QDRANT_STARTING",
  "INFRA_QDRANT_RECOVERING",
  "INFRA_QDRANT_TIMEOUT",
  "INFRA_QDRANT_OPERATION_FAILED",
  "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS",
  "INFRA_QDRANT_VERSION_TOO_OLD",
  "INFRA_QDRANT_DOWNGRADE_NOT_SUPPORTED",
  "INFRA_QDRANT_VECTOR_DIMENSION_MISMATCH",
  "INFRA_COLLECTION_ALREADY_EXISTS",
  "INFRA_ALIAS_OPERATION",
  "INFRA_QDRANT_POINT_NOT_FOUND",
  // Embeddings
  "INFRA_OLLAMA_UNAVAILABLE",
  "INFRA_OLLAMA_TIMEOUT",
  "INFRA_OLLAMA_RESPONSE_ERROR",
  "INFRA_OLLAMA_CONTEXT_OVERFLOW",
  "INFRA_OLLAMA_MODEL_MISSING",
  "INFRA_ONNX_MODEL_LOAD_FAILED",
  "INFRA_ONNX_INFERENCE_FAILED",
  "INFRA_ONNX_PACKAGE_MISSING",
  "INFRA_OPENAI_RATE_LIMIT",
  "INFRA_OPENAI_AUTH_FAILED",
  "INFRA_COHERE_RATE_LIMIT",
  "INFRA_COHERE_API",
  "INFRA_VOYAGE_RATE_LIMIT",
  "INFRA_VOYAGE_API",
  "INFRA_EMBEDDING_MODEL_MISMATCH",
  // Git
  "INFRA_GIT_CLI_NOT_FOUND",
  "INFRA_GIT_CLI_TIMEOUT",
  "INFRA_VCS_ADAPTER_UNAVAILABLE",
  // Registry
  "INFRA_REGISTRY_FILE_CORRUPTED",
  "INFRA_REGISTRY_WRITE_FAILED",
  "INFRA_REGISTRY_CONCURRENCY",
  "INFRA_REGISTRY_NAME_CONFLICT",
  "INFRA_REGISTRY_QDRANT_BACKEND_UNRESOLVED",
  // DuckDB (codegraph adapter)
  "INFRA_DUCKDB_OPEN_FAILED",
  "INFRA_DUCKDB_CLOSE_FAILED",
  "INFRA_DUCKDB_STREAM_INCOMPLETE",
  "INFRA_CODEGRAPH_SHADOW_DATABASE_REFUSED",
  // Codegraph daemon
  "INFRA_CODEGRAPH_DAEMON_STALE_BUILD",
  "INFRA_CODEGRAPH_CLIENT_STALE_BUILD",
  "INFRA_CODEGRAPH_DAEMON_BUILD_SKEW",
  "INFRA_CODEGRAPH_DAEMON_EXIT_TIMEOUT",
  "INFRA_CODEGRAPH_DAEMON_UNREACHABLE",
  "INFRA_CODEGRAPH_DAEMON_UNRESPONSIVE",
  "INFRA_CODEGRAPH_DAEMON_REQUEST_ABORTED",
  "INFRA_CODEGRAPH_DAEMON_DRAIN_REFUSED",
  "INFRA_CODEGRAPH_DAEMON_BUILD_UNAVAILABLE",
] as const;

/** Infrastructure error codes. Local strict union, derived from `INFRA_ERROR_CODES`. */
export type InfraErrorCode = (typeof INFRA_ERROR_CODES)[number];

/**
 * Abstract base class for infrastructure errors (adapters, external services).
 * Default httpStatus: 503 (Service Unavailable).
 */
export abstract class InfraError extends TeaRagsError {
  constructor(opts: { code: InfraErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 503 });
  }
}
