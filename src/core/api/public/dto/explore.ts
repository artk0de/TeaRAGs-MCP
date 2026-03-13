/**
 * Explore domain DTOs — search request/response types.
 */

import type { RankingOverlay } from "../../../contracts/types/reranker.js";

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
// Typed filter params (shared across all search requests)
// ---------------------------------------------------------------------------

/** Typed filter params resolved via TrajectoryRegistry.buildFilter(). */
export interface TypedFilterParams {
  // Static trajectory filters
  language?: string;
  fileExtension?: string;
  chunkType?: string;
  isDocumentation?: boolean;
  excludeDocumentation?: boolean;
  fileTypes?: string[];
  documentationOnly?: boolean;
  // Git trajectory filters
  author?: string;
  modifiedAfter?: string | Date;
  modifiedBefore?: string | Date;
  minAgeDays?: number;
  maxAgeDays?: number;
  minCommitCount?: number;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Search request types
// ---------------------------------------------------------------------------

/**
 * Semantic (dense vector) search request.
 * Intentionally separate from HybridSearchRequest to allow future divergence
 * (e.g., hybrid may gain fusionWeight, sparse boosting params).
 */
export interface SemanticSearchRequest extends CollectionRef, TypedFilterParams {
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
export interface HybridSearchRequest extends CollectionRef, TypedFilterParams {
  query: string;
  limit?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
}

export interface RankChunksRequest extends CollectionRef, TypedFilterParams {
  rerank: string | { custom: Record<string, number> };
  level: "chunk" | "file";
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  metaOnly?: boolean;
}

export interface ExploreCodeRequest extends TypedFilterParams {
  path: string;
  query: string;
  limit?: number;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  filter?: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Search response types
// ---------------------------------------------------------------------------

export interface ExploreResponse {
  results: SearchResult[];
  driftWarning: string | null;
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
