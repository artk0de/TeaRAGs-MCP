/**
 * Explore domain DTOs — search request/response types.
 */

import type { RankingOverlay, SignalLevel } from "../../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { WorkingTreeMarker, WorkingTreeState } from "../../../contracts/types/working-tree.js";
import type { SearchConfidence } from "../../../domains/explore/index.js";
import type { CollectionIdentifier } from "./common.js";

// ---------------------------------------------------------------------------
// Collection reference (shared by search requests)
// ---------------------------------------------------------------------------

/**
 * Identifies a collection by name, by registered project alias, or by codebase
 * path (resolved to collection name internally). At least one of collection,
 * project, or path must be provided. Runtime validation enforces this.
 *
 * Alias of {@link CollectionIdentifier} retained for backward compatibility
 * with the legacy CollectionRef API surface.
 */
export type CollectionRef = CollectionIdentifier;

// ---------------------------------------------------------------------------
// Typed filter params (shared across all search requests)
// ---------------------------------------------------------------------------

/** Typed filter params resolved via TrajectoryRegistry.buildFilter(). */
export interface TypedFilterParams {
  // Static trajectory filters
  language?: string;
  fileExtension?: string | string[];
  chunkType?: string;
  documentation?: "only" | "exclude" | "include";
  testFile?: "only" | "exclude" | "include";
  symbolId?: string;
  // Git trajectory filters
  author?: string;
  recentAuthor?: string;
  contributor?: string;
  modifiedAfter?: string | Date;
  modifiedBefore?: string | Date;
  minAgeDays?: number;
  maxAgeDays?: number;
  minCommitCount?: number;
  taskId?: string;
  // Codegraph trajectory filters (level-aware where noted; default level: file)
  minFanIn?: number;
  minFanOut?: number;
  minPageRank?: number;
  minInstability?: number;
  minTransitiveImpact?: number;
  minConnectionCount?: number;
  isHub?: boolean;
  isLeaf?: boolean;
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
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
  level?: SignalLevel;
  /**
   * Payload allow-list: dot-paths kept in each result's payload, applied
   * server-side before serialization (e.g. `["relativePath",
   * "git.file.commitCount"]`). Omitted → the full payload, exactly as before.
   * A path that matched no result comes back on `fieldsWarning`.
   */
  fields?: string[];
}

/**
 * Hybrid (dense + BM25 sparse) search request.
 * Intentionally separate from SemanticSearchRequest to allow future divergence
 * (e.g., fusionWeight, sparse boosting params).
 */
export interface HybridSearchRequest extends CollectionRef, TypedFilterParams {
  query: string;
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
  level?: SignalLevel;
  /**
   * Payload allow-list: dot-paths kept in each result's payload, applied
   * server-side before serialization (e.g. `["relativePath",
   * "git.file.commitCount"]`). Omitted → the full payload, exactly as before.
   * A path that matched no result comes back on `fieldsWarning`.
   */
  fields?: string[];
}

export interface RankChunksRequest extends CollectionRef, TypedFilterParams {
  rerank: string | { custom: Record<string, number> };
  level?: SignalLevel;
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  metaOnly?: boolean;
  /**
   * Payload allow-list: dot-paths kept in each result's payload, applied
   * server-side before serialization (e.g. `["relativePath",
   * "git.file.commitCount"]`). Omitted → the full payload, exactly as before.
   * A path that matched no result comes back on `fieldsWarning`.
   */
  fields?: string[];
}

export interface ExploreCodeRequest extends TypedFilterParams {
  collection?: string;
  project?: string;
  path?: string;
  query: string;
  limit?: number;
  offset?: number;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  filter?: Record<string, unknown>;
}

/**
 * Find similar chunks using Qdrant recommend sub-query.
 * At least one positiveIds or positiveCode entry is required.
 */
export interface FindSimilarRequest extends CollectionRef {
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  filter?: Record<string, unknown>;
  pathPattern?: string;
  fileExtensions?: string[];
  rerank?: string | { custom: Record<string, number> };
  limit?: number;
  offset?: number;
  metaOnly?: boolean;
  level?: SignalLevel;
  /**
   * Payload allow-list: dot-paths kept in each result's payload, applied
   * server-side before serialization (e.g. `["relativePath",
   * "git.file.commitCount"]`). Omitted → the full payload, exactly as before.
   * A path that matched no result comes back on `fieldsWarning`.
   */
  fields?: string[];
}

/**
 * Find symbol by name — direct Qdrant scroll, no embedding.
 * Returns merged definition for functions, outline for classes.
 * When relativePath is provided instead of symbol, returns file-level outline.
 */
export interface FindSymbolRequest extends CollectionRef {
  /** Symbol name to find. Mutually exclusive with relativePath. */
  symbol?: string;
  /** File path for file-level lookup. Mutually exclusive with symbol. */
  relativePath?: string;
  language?: string;
  pathPattern?: string;
  metaOnly?: boolean;
  rerank?: string | { custom: Record<string, number> };
  limit?: number;
  offset?: number;
  /**
   * Payload allow-list: dot-paths kept in each result's payload, applied
   * server-side before serialization (e.g. `["relativePath",
   * "git.file.commitCount"]`). Omitted → the full payload, exactly as before.
   * A path that matched no result comes back on `fieldsWarning`.
   */
  fields?: string[];
}

// ---------------------------------------------------------------------------
// Search result types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
  /**
   * The working tree changed (`modified`) or deleted (`deleted`) this row's
   * file and the tool has no floor to answer from the tree (bd
   * tea-rags-mcp-xi2r9.3). Absent on rows the tree did not touch.
   */
  treeState?: WorkingTreeState;
}

/**
 * A rerank preset's DEFAULT filter narrowed the candidate set, and the caller
 * never wrote it. Emitted ONLY for that case: an explicit `filter` param, an
 * explicit `filter: {}` clear, and a default that was dropped for excluding
 * the caller's own scope all leave this absent.
 *
 * `excluded` is deliberately optional and is omitted today: the search issues
 * one Qdrant query, so the unfiltered candidate count is not at hand and
 * obtaining it would cost a second round-trip on every search
 * (bd tea-rags-mcp-0qfpi).
 */
export interface PresetFilterNotice {
  /** Rerank preset whose default filter applied, e.g. "techDebt". */
  preset: string;
  /**
   * What narrowed: the filter-preset name(s) the default names, then the
   * payload keys the compiled filter constrains — e.g. `production (isTest)`.
   * A default written as a raw Qdrant filter has no name, so it reads
   * `raw filter (<keys>)`.
   */
  by: string;
  /** The literal search param that clears the default. Always `filter: {}`. */
  clearWith: string;
  /** Candidates the default removed. Present only when the count came free. */
  excluded?: number;
}

// ---------------------------------------------------------------------------
// Search response types
// ---------------------------------------------------------------------------

export interface ExploreResponse {
  results: SearchResult[];
  driftWarning: string | null;
  /** Effective signal level used for scoring and grouping. Present when level was explicitly resolved. */
  level?: SignalLevel;
  /**
   * Match quality read against the collection's own similarity scale. Present
   * only for the tools whose score is a genuine similarity (semantic_search,
   * find_similar) and only when that scale has been measured. Absent for
   * hybrid_search (RRF scores are rank-derived), rank_chunks and find_symbol.
   * Advisory — never filters results.
   */
  confidence?: SearchConfidence;
  /**
   * Present only when an OPTIONAL codegraph lookup was skipped because the
   * codegraph store cannot be reached from this process (daemon from another
   * build, build skew, daemon unreachable, lock held). Names the error code and
   * the remedy. The answer stays valid for what Qdrant holds but may miss what
   * the lookup would have added. Today: find_symbol's collapsed-symbol fallback.
   */
  codegraphWarning?: string;
  /**
   * Present only when a rerank preset's DEFAULT filter — one the caller never
   * wrote — narrowed the candidate set. Names the preset, the condition and
   * how to clear it, so a thin or empty answer is attributable without having
   * read the preset's definition first.
   */
  presetFilterNotice?: PresetFilterNotice;
  /**
   * Present only when a `fields` path matched NO result. The payload shape is
   * not statically knowable — `git.*` exists only where git enrichment ran —
   * so a miss is reported rather than rejected, and the message names any path
   * in the returned payloads carrying the same leaf. Results still return.
   */
  fieldsWarning?: string;
  /**
   * Which working tree the answer read and how far it is from the index (bd
   * tea-rags-mcp-xi2r9). Present whenever the server wires the overlay — on
   * every return path, empty results and `metaOnly` included. `degraded` names
   * what could not be measured.
   */
  workingTree?: WorkingTreeMarker;
}

// ---------------------------------------------------------------------------
// Schema descriptor types (for MCP Zod schema generation)
// ---------------------------------------------------------------------------

export interface SignalDescriptor {
  name: string;
  description: string;
}

export interface PresetDetail {
  name: string;
  description: string;
  /** Weight key names available in this preset. */
  weights: string[];
  /** Tool names this preset is available for. */
  tools: string[];
}

export interface PresetDescriptors {
  /** Preset names keyed by tool name (e.g. { semantic_search: ["relevance", "techDebt"] }) */
  presetNames: Record<string, string[]>;
  /** Full preset details keyed by tool name */
  presetDetails: Record<string, PresetDetail[]>;
  /** All derived signal descriptors available for custom weights */
  signalDescriptors: SignalDescriptor[];
  /** All payload signal descriptors (for dynamic resource generation) */
  payloadSignals: PayloadSignalDescriptor[];
}
