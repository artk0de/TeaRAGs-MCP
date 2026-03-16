/**
 * DTO barrel — re-exports all domain DTOs.
 */

export type {
  // Explore
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  FindSimilarRequest,
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDetail,
  PresetDescriptors,
} from "./explore.js";

export type {
  // Ingest
  IndexOptions,
  IndexStats,
  IndexStatus,
  ChangeStats,
  ProgressCallback,
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
