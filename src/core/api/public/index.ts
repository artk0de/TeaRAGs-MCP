/**
 * Public API barrel — exports App contract and all DTOs.
 */

export { createApp } from "./app.js";
export type { App, AppDeps } from "./app.js";

export type {
  // Explore DTOs
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDescriptors,
  // Ingest DTOs
  IndexOptions,
  IndexStats,
  IndexStatus,
  ChangeStats,
  ProgressCallback,
  // Collection DTOs
  CreateCollectionRequest,
  CollectionInfo,
  // Document DTOs
  AddDocumentsRequest,
  DeleteDocumentsRequest,
} from "./dto/index.js";
