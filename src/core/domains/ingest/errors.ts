/**
 * Ingest domain errors — indexing, collections, snapshots.
 */

import type { ErrorCode } from "../../contracts/errors.js";
import { TeaRagsError } from "../../infra/errors.js";

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
