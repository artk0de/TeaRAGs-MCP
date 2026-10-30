export {
  ExploreError,
  CollectionNotFoundError,
  HybridNotEnabledError,
  InvalidQueryError,
  InvalidStrategyError,
  UnknownFilterPresetError,
  EmptyFilterPresetError,
} from "./errors/index.js";
export type { ExploreErrorCode } from "./errors/index.js";
export { Reranker } from "./reranker.js";
export { QUERY_VARIANT_SEPARATOR, splitQueryVariants, withoutWorkingTreeFloors } from "./query-variants.js";
export type { ExploreQueryVariant } from "./query-variants.js";
export type { ScoringWeights, RerankableResult, RerankMode } from "./reranker.js";
export type { RerankerPort, RerankOptions } from "./reranker-port.js";
export type { DeclaredVisibilityIndex } from "./declared-visibility-index.js";
export type { ExploreRequestScope } from "./request-scope.js";
export { historyClockRerankOption } from "./history-clock.js";
export { OrderByFieldResolver, RankModule, type RankOptions } from "./rank-module.js";
export { toolCallAddressFromWorkingTree } from "./tool-call-address.js";
export { splitFragmentBase } from "./chunk-grouping/index.js";
export { computeSearchConfidence } from "./confidence.js";
export type { SearchConfidence, SearchConfidenceInput } from "./confidence.js";
export {
  computeFetchLimit,
  postProcess,
  filterMetaOnly,
  chunkSignature,
  type SearchResult,
  type FetchLimits,
  type PostProcessOptions,
} from "./post-process.js";
export { resolvePresets, getPresetNames, getPresetWeights } from "./rerank/presets/index.js";
export type { RerankPreset } from "./rerank/presets/index.js";
export { CodeChunkGrouper, DocChunkGrouper } from "./chunk-grouping/index.js";
export type { ScrollChunk } from "./chunk-grouping/index.js";
export { IndexMetricsQuery } from "./queries/index-metrics.js";
export { MIGRATION_ID_PREFIX, MigrationCorpusQuery, RAILS_TABLE_ID_PREFIX } from "./queries/migration-corpus.js";
export { SymbolBatchDrill, type SymbolBatchAnswer, type SymbolBatchRow } from "./symbol-batch.js";
export { SymbolMissExplainer } from "./symbol-miss.js";
export {
  createExploreStrategy,
  HybridSearchStrategy,
  ScrollRankStrategy,
  BaseExploreStrategy,
  SimilarSearchStrategy,
  SymbolSearchStrategy,
  FileOutlineStrategy,
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
  WorkingTreeContentHashes,
  WorkingTreeDeltaWarmer,
  WorkingTreeDenseVectorSource,
  WorkingTreeOverlay,
  WorkingTreeTouchedBasePoints,
  WorkingTreeWatcher,
  WorkingTreeChangeClock,
  workingTreeStateOf,
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
