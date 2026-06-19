import { InfraError } from "../../../adapters/errors.js";
import { FileParseError, FileReadError, IngestError, QuarantinableIngestError } from "../errors.js";

/** Node filesystem error codes that mean the file itself could not be read. */
const FS_READ_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
]);

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
