/**
 * App-level DTOs — re-exported from api/public/dto/ for backward compatibility.
 *
 * Canonical source: core/api/public/dto/
 */

export type {
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
} from "../../api/public/dto/explore.js";

export type { CreateCollectionRequest, CollectionInfo } from "../../api/public/dto/collection.js";

export type { AddDocumentsRequest, DeleteDocumentsRequest } from "../../api/public/dto/document.js";
