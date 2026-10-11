export {
  IngestError,
  NotIndexedError,
  CollectionExistsError,
  SnapshotMissingError,
  PipelineNotStartedError,
  IngestInvariantError,
} from "./errors.js";
export type { IngestErrorCode } from "./errors.js";
export { IndexPipeline, ReindexPipeline } from "./operations/index.js";
export { cleanupOrphanedVersions, computeCollectionStats } from "./infra/index.js";
export type { IngestDependencies, SynchronizerTuning } from "./factory.js";
export { INDEXING_METADATA_ID } from "../../contracts/constants.js";
export { enrichmentSkipReason, fileLinesOf, type EnrichmentSkipReason } from "./pipeline/enrichment/index.js";
