/**
 * Ingest error vocabulary barrel.
 *
 * The error vocabulary is a leaf component below the ingest root: pipeline,
 * sync, operations and infra all consume it, so nothing in here may import an
 * ingest child directory back (`tests/core/domains/ingest/
 * ingest-import-direction.test.ts` pins that). Files inside `ingest/` import
 * this barrel; consumers outside the domain import the full
 * `domains/ingest/errors/index.js` path. The ingest root facade re-exports its
 * public subset, so the external surface is unchanged.
 */

export {
  AST_NOT_PROCESSED_REASON,
  ChunkOversizedError,
  CollectionExistsError,
  EmbeddingRejectedError,
  FileParseError,
  FileReadError,
  IndexingAlreadyInProgressError,
  IndexingFailedError,
  IndexingLockUnavailableError,
  IndexingProcessBuildStaleError,
  IngestError,
  IngestInvariantError,
  NotIndexedError,
  PartialDeletionError,
  PipelineNotStartedError,
  QdrantPayloadTooLargeError,
  QuarantinableIngestError,
  ReindexFailedError,
  SnapshotCorruptedError,
  SnapshotMissingError,
  VersionedCollectionClaimError,
  WorkerTimeoutError,
  WorktreeSeedMarkerUnconfirmedError,
  WorktreeSeedMarkerUnreadableError,
} from "./ingest-errors.js";
export type { IngestErrorCode, QuarantinePhase } from "./ingest-errors.js";
