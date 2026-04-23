/**
 * Error contract — defines the shape all TeaRags errors must satisfy.
 */

/**
 * Every TeaRags error implements this contract.
 * Machine-readable code, human-readable message+hint, HTTP status, optional cause.
 */
export interface TeaRagsErrorContract {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly httpStatus: number;
  readonly cause?: Error;
}

/**
 * Error codes organized by domain.
 *
 * Convention: DOMAIN_SPECIFIC_ERROR
 */
export type ErrorCode =
  // Unknown
  | "UNKNOWN_ERROR"
  // Input validation
  | "INPUT_COLLECTION_NOT_PROVIDED"
  | "INPUT_MISSING_ARGUMENT"
  | "INPUT_INVALID_PARAMETER"
  // Infra — Qdrant
  | "INFRA_QDRANT_UNAVAILABLE"
  | "INFRA_QDRANT_TIMEOUT"
  | "INFRA_QDRANT_OPERATION_FAILED"
  | "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS"
  | "INFRA_COLLECTION_ALREADY_EXISTS"
  | "INFRA_ALIAS_OPERATION"
  | "INFRA_QDRANT_POINT_NOT_FOUND"
  // Infra — Embeddings
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
  // Infra — Git
  | "INFRA_GIT_CLI_NOT_FOUND"
  | "INFRA_GIT_CLI_TIMEOUT"
  // Domain — Ingest
  | "INGEST_NOT_INDEXED"
  | "INGEST_COLLECTION_EXISTS"
  | "INGEST_SNAPSHOT_MISSING"
  | "INGEST_SNAPSHOT_CORRUPTED"
  | "INGEST_MIGRATION_FAILED"
  | "INGEST_REINDEX_FAILED"
  | "INGEST_INDEXING_FAILED"
  // Domain — Ingest (invariants)
  | "INGEST_PIPELINE_NOT_STARTED"
  | "INGEST_INVARIANT_VIOLATED"
  // Domain — Explore
  | "EXPLORE_COLLECTION_NOT_FOUND"
  | "EXPLORE_HYBRID_NOT_ENABLED"
  | "EXPLORE_INVALID_QUERY"
  | "EXPLORE_INVALID_STRATEGY"
  | "EXPLORE_CHUNK_NOT_FOUND"
  // Domain — Trajectory
  | "TRAJECTORY_GIT_BLAME_FAILED"
  | "TRAJECTORY_GIT_LOG_TIMEOUT"
  | "TRAJECTORY_GIT_NOT_AVAILABLE"
  | "TRAJECTORY_STATIC_PARSE_FAILED"
  // Config
  | "CONFIG_VALUE_INVALID"
  | "CONFIG_VALUE_MISSING"
  | "CONFIG_NOT_INITIALIZED";
