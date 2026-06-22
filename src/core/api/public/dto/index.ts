/**
 * DTO barrel — re-exports all domain DTOs.
 */

export type { CollectionIdentifier } from "./common.js";

export type {
  // Explore
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  FindSimilarRequest,
  FindSymbolRequest,
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDetail,
  PresetDescriptors,
} from "./explore.js";

export type {
  // Ingest
  IndexOptions,
  IndexCodebaseInput,
  IndexStats,
  IndexStatus,
  ChangeStats,
  ProgressCallback,
  EnrichmentProgressCallback,
  EnrichmentProgressEvent,
} from "./ingest.js";

export type {
  // Collection
  CreateCollectionRequest,
  CollectionInfo,
} from "./collection.js";

export type {
  // Document
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./document.js";

export type { IndexMetrics, SignalMetrics } from "./metrics.js";

export type {
  // Codegraph
  CalleeResult,
  CallerResult,
  CycleResult,
  FindCyclesRequest,
  FindCyclesResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
  // trace_path
  TracePathRequest,
  PathStep,
  TracedPath,
  PathTraceResult,
} from "./graph.js";

export { stripInternalFields } from "./sanitize.js";
