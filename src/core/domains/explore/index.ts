export {
  ExploreError,
  CollectionNotFoundError,
  HybridNotEnabledError,
  InvalidQueryError,
  InvalidStrategyError,
  UnknownFilterPresetError,
  EmptyFilterPresetError,
} from "./errors.js";
export type { ExploreErrorCode } from "./errors.js";
export { Reranker } from "./reranker.js";
export type { ScoringWeights, RerankableResult, RerankMode } from "./reranker.js";
export { historyClockRerankOption } from "./history-clock.js";
export { OrderByFieldResolver, RankModule, type RankOptions } from "./rank-module.js";
export { computeSearchConfidence } from "./confidence.js";
export type { SearchConfidence, SearchConfidenceInput } from "./confidence.js";
export {
  computeFetchLimit,
  postProcess,
  filterMetaOnly,
  type SearchResult,
  type FetchLimits,
  type PostProcessOptions,
} from "./post-process.js";
export { resolvePresets, getPresetNames, getPresetWeights } from "./rerank/presets/index.js";
export type { RerankPreset } from "./rerank/presets/index.js";
export { CodeChunkGrouper, DocChunkGrouper } from "./chunk-grouping/index.js";
export type { ScrollChunk } from "./chunk-grouping/index.js";
export {
  createExploreStrategy,
  HybridSearchStrategy,
  ScrollRankStrategy,
  BaseExploreStrategy,
  SimilarSearchStrategy,
  VectorSearchStrategy,
} from "./strategies/index.js";
export type {
  ExploreStrategyType,
  ExploreContext,
  ExploreResult,
  ExploreStrategy,
  SimilarSearchInput,
} from "./strategies/index.js";
export {
  claimWorkingTreeFloors,
  createWorkingTreeBasePointStore,
  createWorkingTreeChunkLayer,
  createWorkingTreeChunkStore,
  createWorkingTreeDeltaReader,
  createWorkingTreeFileWriter,
  mergedWorkingTreeSymbolRow,
  recordTreeGraphState,
  relativePathOf,
  scheduleWorkingTreeBasePointSweep,
  scheduleWorkingTreeChunkSweep,
  WorkingTreeDeltaWarmer,
  WorkingTreeDenseVectorSource,
  WorkingTreeOverlay,
  WorkingTreeTouchedBasePoints,
  WorkingTreeWatcher,
} from "./working-tree/index.js";
export type {
  WorkingTreeChunkerPool,
  WorkingTreeChunkLayer,
  WorkingTreeChunkLayerDeps,
  WorkingTreeChunkLayerRead,
  WorkingTreeChunkStore,
  WorkingTreeChunkStoreEntry,
  WorkingTreeChunkStoreKey,
  WorkingTreeDeltaChunkSource,
  WorkingTreeSourceFile,
  WorkingTreeDelta,
  WorkingTreeDeltaRead,
  WorkingTreeDeltaReader,
  WorkingTreeIndexLookup,
  WorkingTreeOverlayDeps,
  WorkingTreeView,
} from "./working-tree/index.js";
