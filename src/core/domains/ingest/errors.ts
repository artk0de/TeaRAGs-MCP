/**
 * Ingest domain errors — indexing, collections, snapshots.
 */

import type { ErrorCode } from "../../contracts/errors.js";
import { TeaRagsError } from "../../infra/errors.js";
import type { DeletionOutcome } from "./sync/deletion-outcome.js";

/**
 * Abstract base for all ingest domain errors.
 * Default httpStatus: 400.
 */
export abstract class IngestError extends TeaRagsError {
  constructor(opts: { code: ErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
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
