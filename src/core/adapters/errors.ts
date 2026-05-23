/**
 * Abstract base for all infrastructure/adapter errors.
 *
 * Covers Qdrant, embeddings, git CLI — anything outside the core domain
 * that can fail due to external service unavailability.
 */

import { TeaRagsError } from "../infra/errors.js";

/**
 * Infrastructure error codes. Local strict union — Qdrant, embeddings, git CLI,
 * registry. Concrete InfraError subclasses live in
 * adapters/{qdrant,embeddings,git,registry}/errors.ts.
 */
export type InfraErrorCode =
  // Qdrant
  | "INFRA_QDRANT_UNAVAILABLE"
  | "INFRA_QDRANT_STARTING"
  | "INFRA_QDRANT_RECOVERING"
  | "INFRA_QDRANT_TIMEOUT"
  | "INFRA_QDRANT_OPERATION_FAILED"
  | "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS"
  | "INFRA_QDRANT_VERSION_TOO_OLD"
  | "INFRA_QDRANT_DOWNGRADE_NOT_SUPPORTED"
  | "INFRA_COLLECTION_ALREADY_EXISTS"
  | "INFRA_ALIAS_OPERATION"
  | "INFRA_QDRANT_POINT_NOT_FOUND"
  // Embeddings
  | "INFRA_OLLAMA_UNAVAILABLE"
  | "INFRA_OLLAMA_TIMEOUT"
  | "INFRA_OLLAMA_RESPONSE_ERROR"
  | "INFRA_OLLAMA_CONTEXT_OVERFLOW"
  | "INFRA_OLLAMA_MODEL_MISSING"
  | "INFRA_ONNX_MODEL_LOAD_FAILED"
  | "INFRA_ONNX_INFERENCE_FAILED"
  | "INFRA_ONNX_PACKAGE_MISSING"
  | "INFRA_OPENAI_RATE_LIMIT"
  | "INFRA_OPENAI_AUTH_FAILED"
  | "INFRA_COHERE_RATE_LIMIT"
  | "INFRA_COHERE_API"
  | "INFRA_VOYAGE_RATE_LIMIT"
  | "INFRA_VOYAGE_API"
  | "INFRA_EMBEDDING_MODEL_MISMATCH"
  // Git
  | "INFRA_GIT_CLI_NOT_FOUND"
  | "INFRA_GIT_CLI_TIMEOUT"
  // Registry
  | "INFRA_REGISTRY_FILE_CORRUPTED"
  | "INFRA_REGISTRY_WRITE_FAILED"
  | "INFRA_REGISTRY_CONCURRENCY"
  | "INFRA_REGISTRY_NAME_CONFLICT"
  // DuckDB (codegraph adapter)
  | "INFRA_DUCKDB_OPEN_FAILED";

/**
 * Abstract base class for infrastructure errors (adapters, external services).
 * Default httpStatus: 503 (Service Unavailable).
 */
export abstract class InfraError extends TeaRagsError {}
