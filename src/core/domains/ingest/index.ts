export {
  IngestError,
  NotIndexedError,
  CollectionExistsError,
  SnapshotMissingError,
  PipelineNotStartedError,
  IngestInvariantError,
} from "./errors.js";
export type { IngestErrorCode } from "./errors.js";
export { IndexPipeline } from "./operations/indexing.js";
export { ReindexPipeline } from "./operations/reindexing.js";
export { computeCollectionStats } from "./collection-stats.js";
export { createIngestDependencies, type IngestDependencies, type SynchronizerTuning } from "./factory.js";
export { INDEXING_METADATA_ID } from "./constants.js";
export { cleanupOrphanedVersions } from "./alias-cleanup.js";
