/**
 * App interface — unified public API contract for tea-rags.
 *
 * MCP layer and any external consumer imports ONLY this interface.
 * The composition root (api/) provides the concrete implementation.
 *
 * DTOs live in contracts/types/app.ts (shared across layers).
 * Domain types (IndexOptions, IndexStats, etc.) are re-exported from ../types.js.
 */

import type {
  AddDocumentsRequest,
  CollectionInfo,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  HybridSearchRequest,
  PresetDescriptors,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchResponse,
  SemanticSearchRequest,
} from "../contracts/types/app.js";
import type { ChangeStats, IndexOptions, IndexStats, IndexStatus, ProgressCallback } from "../types.js";

// ---------------------------------------------------------------------------
// App interface
// ---------------------------------------------------------------------------

export interface App {
  // -- Search --
  semanticSearch: (request: SemanticSearchRequest) => Promise<SearchResponse>;
  hybridSearch: (request: HybridSearchRequest) => Promise<SearchResponse>;
  rankChunks: (request: RankChunksRequest) => Promise<SearchResponse>;
  searchCode: (request: SearchCodeRequest) => Promise<SearchCodeResponse>;

  // -- Indexing --
  indexCodebase: (path: string, options?: IndexOptions, progress?: ProgressCallback) => Promise<IndexStats>;
  reindexChanges: (path: string, progress?: ProgressCallback) => Promise<ChangeStats>;
  getIndexStatus: (path: string) => Promise<IndexStatus>;
  clearIndex: (path: string) => Promise<void>;

  // -- Collections --
  createCollection: (request: CreateCollectionRequest) => Promise<CollectionInfo>;
  listCollections: () => Promise<string[]>;
  getCollectionInfo: (name: string) => Promise<CollectionInfo>;
  deleteCollection: (name: string) => Promise<void>;

  // -- Documents --
  addDocuments: (request: AddDocumentsRequest) => Promise<{ count: number }>;
  deleteDocuments: (request: DeleteDocumentsRequest) => Promise<{ count: number }>;

  // -- Schema descriptors (for MCP Zod schema generation) --
  getSchemaDescriptors: () => PresetDescriptors;

  // -- Drift monitoring --
  checkSchemaDrift: (ref: { path: string } | { collection: string }) => Promise<string | null>;
}

// Re-export all DTOs so consumers can import from api/app.ts (single entry point)
export type {
  AddDocumentsRequest,
  CollectionInfo,
  CollectionRef,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  HybridSearchRequest,
  PresetDescriptors,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchCodeResult,
  SearchResponse,
  SearchResult,
  SemanticSearchRequest,
  SignalDescriptor,
} from "../contracts/types/app.js";

// Re-export domain types consumed by App methods
export type { ChangeStats, IndexOptions, IndexStats, IndexStatus, ProgressCallback };
