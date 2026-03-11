/**
 * App-level DTOs — request/response types for the unified public API.
 *
 * Lives in contracts/ because these types are shared across layers:
 * api/ (implementation), mcp/ (consumers), bootstrap/ (wiring).
 */

import type { RankingOverlay } from "./reranker.js";

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
