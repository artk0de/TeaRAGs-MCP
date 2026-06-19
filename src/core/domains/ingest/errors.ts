/**
 * Ingest domain errors — indexing, collections, snapshots.
 */

import { TeaRagsError } from "../../infra/errors.js";
import type { DeletionOutcome } from "./sync/deletion/outcome.js";

/**
 * Ingest domain error codes. Local strict union.
 */
export type IngestErrorCode =
  | "INGEST_NOT_INDEXED"
  | "INGEST_COLLECTION_EXISTS"
  | "INGEST_SNAPSHOT_MISSING"
  | "INGEST_SNAPSHOT_CORRUPTED"
  | "INGEST_MIGRATION_FAILED"
  | "INGEST_REINDEX_FAILED"
  | "INGEST_INDEXING_FAILED"
  | "INGEST_PARTIAL_DELETION"
  | "INGEST_PIPELINE_NOT_STARTED"
  | "INGEST_INVARIANT_VIOLATED"
  | "INGEST_CHUNK_OVERSIZED"
  | "INGEST_EMBEDDING_REJECTED"
  | "INGEST_PAYLOAD_TOO_LARGE"
  | "INGEST_FILE_PARSE_FAILED"
  | "INGEST_FILE_READ_FAILED";

/**
 * Phase of the indexing pipeline in which a file failed. Carried by
 * QuarantinableIngestError so the on-disk quarantine entry records where the
 * breakage occurred.
 */
export type QuarantinePhase = "parse" | "embed" | "upsert" | "enrich" | "fs";

/**
 * Abstract base for all ingest domain errors.
 * Default httpStatus: 400.
 */
export abstract class IngestError extends TeaRagsError {
  constructor(opts: { code: IngestErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 400 });
  }
}

/** Codebase at the given path has not been indexed yet. */
export class NotIndexedError extends IngestError {
  constructor(path: string) {
    super({
      code: "INGEST_NOT_INDEXED",
      message: `Codebase at "${path}" is not indexed`,
      hint: `Run index_codebase first to index the codebase at ${path}`,
      httpStatus: 404,
    });
  }
}

/** A collection with this name already exists. */
export class CollectionExistsError extends IngestError {
  constructor(collectionName: string) {
    super({
      code: "INGEST_COLLECTION_EXISTS",
      message: `Collection "${collectionName}" already exists`,
      hint: "Use a different collection name or delete the existing collection first",
      httpStatus: 409,
    });
  }
}

/** Required snapshot file is missing at the expected path. */
export class SnapshotMissingError extends IngestError {
  constructor(path: string) {
    super({
      code: "INGEST_SNAPSHOT_MISSING",
      message: `Snapshot not found at "${path}"`,
      hint: "Ensure the snapshot file exists and the path is correct",
      httpStatus: 404,
    });
  }
}

/** Snapshot data is corrupted (checksum mismatch, unparseable meta). */
export class SnapshotCorruptedError extends IngestError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INGEST_SNAPSHOT_CORRUPTED",
      message: `Snapshot corrupted: ${detail}`,
      hint: "Delete the snapshot and re-index the codebase with forceReindex=true",
      cause,
    });
  }
}

/** Pipeline method called before start(). */
export class PipelineNotStartedError extends IngestError {
  constructor(component: string) {
    super({
      code: "INGEST_PIPELINE_NOT_STARTED",
      message: `${component} not started`,
      hint: "Call start() before using the pipeline",
      httpStatus: 500,
    });
  }
}

/** Programming invariant violated in ingest domain. */
export class IngestInvariantError extends IngestError {
  constructor(detail: string) {
    super({
      code: "INGEST_INVARIANT_VIOLATED",
      message: `Invariant violated: ${detail}`,
      hint: "This is a programming error — report it as a bug",
      httpStatus: 500,
    });
  }
}

/** Incremental re-indexing failed unexpectedly. */
export class ReindexFailedError extends IngestError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INGEST_REINDEX_FAILED",
      message: `Incremental re-indexing failed: ${detail}`,
      hint: "Check server logs for details, or re-index with forceReindex=true",
      httpStatus: 500,
      cause,
    });
  }
}

/** Full indexing failed unexpectedly. */
export class IndexingFailedError extends IngestError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INGEST_INDEXING_FAILED",
      message: `Full indexing failed: ${detail}`,
      hint: "Check server logs for details, or retry with forceReindex=true",
      httpStatus: 500,
      cause,
    });
  }
}

/**
 * Marker base for errors that should quarantine the offending file instead of
 * aborting the pipeline or being silently dropped. Subclasses pin the pipeline
 * `phase` so the on-disk quarantine entry records where the breakage occurred.
 */
export abstract class QuarantinableIngestError extends IngestError {
  abstract readonly phase: QuarantinePhase;
}

/** Chunk exceeds the embedding model context after enforceMaxChunkSize split. */
export class ChunkOversizedError extends QuarantinableIngestError {
  readonly phase = "embed";

  constructor(relativePath: string, detail: string, cause?: Error) {
    super({
      code: "INGEST_CHUNK_OVERSIZED",
      message: `Chunk in "${relativePath}" oversized: ${detail}`,
      hint: "File quarantined; it will be retried automatically on the next index pass.",
      cause,
    });
  }
}

/** Embedding adapter rejected the input (4xx: malformed input, content policy). */
export class EmbeddingRejectedError extends QuarantinableIngestError {
  readonly phase = "embed";

  constructor(relativePath: string, detail: string, cause?: Error) {
    super({
      code: "INGEST_EMBEDDING_REJECTED",
      message: `Embedding rejected for "${relativePath}": ${detail}`,
      hint: "File quarantined; it will be retried automatically on the next index pass.",
      cause,
    });
  }
}

/** Qdrant returned 413 — the upsert payload for this file was too large. */
export class QdrantPayloadTooLargeError extends QuarantinableIngestError {
  readonly phase = "upsert";

  constructor(relativePath: string, detail: string, cause?: Error) {
    super({
      code: "INGEST_PAYLOAD_TOO_LARGE",
      message: `Qdrant payload too large for "${relativePath}": ${detail}`,
      hint: "File quarantined; it will be retried automatically on the next index pass.",
      cause,
    });
  }
}

/** tree-sitter or chunker threw while parsing the file. */
export class FileParseError extends QuarantinableIngestError {
  readonly phase = "parse";

  constructor(relativePath: string, detail: string, cause?: Error) {
    super({
      code: "INGEST_FILE_PARSE_FAILED",
      message: `Failed to parse "${relativePath}": ${detail}`,
      hint: "File quarantined; it will be retried automatically on the next index pass.",
      cause,
    });
  }
}

/** fs.readFile threw (permissions, broken symlink, etc.). */
export class FileReadError extends QuarantinableIngestError {
  readonly phase = "fs";

  constructor(relativePath: string, detail: string, cause?: Error) {
    super({
      code: "INGEST_FILE_READ_FAILED",
      message: `Failed to read "${relativePath}": ${detail}`,
      hint: "File quarantined; it will be retried automatically on the next index pass.",
      cause,
    });
  }
}

/**
 * One or more files failed to delete during a reindex pass.
 * Carries the DeletionOutcome so callers can inspect which paths failed.
 */
export class PartialDeletionError extends IngestError {
  public readonly outcome: DeletionOutcome;

  constructor(outcome: DeletionOutcome) {
    const totalAttempted = outcome.succeeded.size + outcome.failed.size;
    super({
      code: "INGEST_PARTIAL_DELETION",
      message: `Failed to delete ${outcome.failed.size} of ${totalAttempted} files`,
      hint: "Rerun reindex to retry, or /tea-rags:force-reindex for full rebuild.",
      httpStatus: 500,
    });
    this.outcome = outcome;
  }
}
