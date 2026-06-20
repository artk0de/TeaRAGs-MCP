import { InfraError } from "../../../adapters/errors.js";
import {
  ChunkOversizedError,
  EmbeddingRejectedError,
  FileParseError,
  FileReadError,
  IngestError,
  QuarantinableIngestError,
} from "../errors.js";

/** Error codes that mean the chunk exceeded the embedding model's context window. */
const CONTEXT_OVERFLOW_CODES = new Set(["INFRA_OLLAMA_CONTEXT_OVERFLOW"]);

/** HTTP statuses from an embedding provider that mean "this input is bad" (not transient). */
const EMBEDDING_BAD_INPUT_STATUSES = new Set([400, 413, 422]);

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "responseStatus" in error) {
    const { responseStatus: status } = error as { responseStatus: unknown };
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** Node filesystem error codes that mean the file itself could not be read. */
const FS_READ_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function fsErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Inspect a raw error thrown during file read / parse and return the matching
 * QuarantinableIngestError subclass, or null if the error is not a poison-pill
 * (transient infra failure, programming invariant) and should follow the
 * existing non-quarantine error path.
 */
export function classifyQuarantinable(error: unknown, relativePath: string): QuarantinableIngestError | null {
  // Already classified upstream — pass through unchanged.
  if (error instanceof QuarantinableIngestError) {
    return error;
  }

  // Transient infra failures (Qdrant unavailable/recovering/timeout) and ingest
  // programming invariants are NOT poison-pill files — leave them to the
  // existing error path so they are retried or surfaced as bugs.
  if (error instanceof InfraError || error instanceof IngestError) {
    return null;
  }

  const cause = error instanceof Error ? error : undefined;
  const detail = error instanceof Error ? error.message : String(error);

  if (FS_READ_ERROR_CODES.has(fsErrorCode(error) ?? "")) {
    return new FileReadError(relativePath, detail, cause);
  }

  return new FileParseError(relativePath, detail, cause);
}

/**
 * Inspect a raw error thrown while embedding a chunk and return the matching
 * QuarantinableIngestError subclass, or null if the error is transient (5xx,
 * rate-limit, network, auth) and should follow the existing retry/abort path.
 * The model context limit is in tokens, so only the adapter's token-level error
 * is a reliable poison signal — char size cannot predict it.
 */
export function classifyEmbeddingQuarantinable(error: unknown, relativePath: string): QuarantinableIngestError | null {
  if (error instanceof QuarantinableIngestError) {
    return error;
  }

  const cause = error instanceof Error ? error : undefined;
  const detail = error instanceof Error ? error.message : String(error);

  if (CONTEXT_OVERFLOW_CODES.has(errorCode(error) ?? "")) {
    return new ChunkOversizedError(relativePath, detail, cause);
  }

  if (EMBEDDING_BAD_INPUT_STATUSES.has(responseStatus(error) ?? -1)) {
    return new EmbeddingRejectedError(relativePath, detail, cause);
  }

  return null;
}
