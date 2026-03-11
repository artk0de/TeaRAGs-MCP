/**
 * App interface — unified public API contract for tea-rags.
 *
 * MCP layer and any external consumer imports ONLY this interface.
 * The composition root (api/) provides the concrete implementation.
 *
 * All request/response types are defined here to keep the contract self-contained.
 * Existing domain types (IndexOptions, IndexStats, etc.) are re-exported from ../types.js.
 */

import type { RankingOverlay } from "../contracts/types/reranker.js";
import type { ChangeStats, IndexOptions, IndexStats, IndexStatus, ProgressCallback } from "../types.js";

// ---------------------------------------------------------------------------
// Collection reference (shared by search requests)
// ---------------------------------------------------------------------------

/**
 * Identifies a collection by name or by codebase path (resolved to collection name internally).
 * At least one of collection or path must be provided. Runtime validation enforces this.
 */
export interface CollectionRef {
  collection?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Search request types
// ---------------------------------------------------------------------------

/**
 * Semantic (dense vector) search request.
 * Intentionally separate from HybridSearchRequest to allow future divergence
 * (e.g., hybrid may gain fusionWeight, sparse boosting params).
 */
export interface SemanticSearchRequest extends CollectionRef {
  query: string;
  limit?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
}

/**
 * Hybrid (dense + BM25 sparse) search request.
 * Intentionally separate from SemanticSearchRequest to allow future divergence
 * (e.g., fusionWeight, sparse boosting params).
 */
export interface HybridSearchRequest extends CollectionRef {
  query: string;
  limit?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
}

export interface RankChunksRequest extends CollectionRef {
  rerank: string | { custom: Record<string, number> };
  level: "chunk" | "file";
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  metaOnly?: boolean;
}

export interface SearchCodeRequest {
  path: string;
  query: string;
  limit?: number;
  fileTypes?: string[];
  pathPattern?: string;
  documentationOnly?: boolean;
  author?: string;
  modifiedAfter?: string | Date;
  modifiedBefore?: string | Date;
  minAgeDays?: number;
  maxAgeDays?: number;
  minCommitCount?: number;
  taskId?: string;
  rerank?: string | { custom: Record<string, number> };
}

// ---------------------------------------------------------------------------
// Search result types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
}

export interface SearchCodeResult {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  fileExtension: string;
  /** Loosely typed for public API. See CodeSearchResult in types.ts for full structure. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Search response types
// ---------------------------------------------------------------------------

export interface SearchResponse {
  results: SearchResult[];
  driftWarning: string | null;
}

export interface SearchCodeResponse {
  results: SearchCodeResult[];
  driftWarning: string | null;
}

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

export interface CreateCollectionRequest {
  name: string;
  distance?: "Cosine" | "Euclid" | "Dot";
  enableHybrid?: boolean;
}

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

export interface AddDocumentsRequest {
  collection: string;
  documents: {
    id: string | number;
    text: string;
    metadata?: Record<string, unknown>;
  }[];
}

export interface DeleteDocumentsRequest {
  collection: string;
  ids: (string | number)[];
}

// ---------------------------------------------------------------------------
// Schema descriptor types (for MCP Zod schema generation)
// ---------------------------------------------------------------------------

export interface SignalDescriptor {
  name: string;
  description: string;
}

export interface PresetDescriptors {
  /** Preset names keyed by tool name (e.g. { semantic_search: ["relevance", "techDebt"] }) */
  presetNames: Record<string, string[]>;
  /** All derived signal descriptors available for custom weights */
  signalDescriptors: SignalDescriptor[];
}

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

// Re-export domain types consumed by App methods
export type { ChangeStats, IndexOptions, IndexStats, IndexStatus, ProgressCallback };
