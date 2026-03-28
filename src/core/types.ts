/**
 * Type definitions for code vectorization module
 */

import type { EnrichmentHealthMap } from "./domains/ingest/pipeline/enrichment/types.js";

/** Config for indexing pipelines (BaseIndexingPipeline, IndexPipeline, ReindexPipeline) */
export interface IngestCodeConfig {
  // Chunking
  chunkSize: number;
  chunkOverlap: number;

  // File discovery
  supportedExtensions: string[];
  ignorePatterns: string[];
  customIgnorePatterns?: string[];

  // Indexing
  maxChunksPerFile?: number;
  maxTotalChunks?: number;

  // Search (used at collection creation time)
  enableHybridSearch: boolean;
  quantizationScalar: boolean;

  // Git metadata (optional, adds author/commit info to chunks)
  enableGitMetadata?: boolean;
}

/** Config for IngestFacade trajectory enrichment setup */
export interface TrajectoryIngestConfig {
  enableGitMetadata?: boolean;
  squashAwareSessions?: boolean;
  sessionGapMinutes?: number;
  trajectoryGit?: {
    logMaxAgeMonths: number;
    logTimeoutMs: number;
    chunkConcurrency: number;
    chunkMaxAgeMonths: number;
    chunkTimeoutMs: number;
    chunkMaxFileLines: number;
  };
}

export interface ScannerConfig {
  supportedExtensions: string[];
  ignorePatterns: string[];
  customIgnorePatterns?: string[];
}

export interface ChunkerConfig {
  chunkSize: number;
  chunkOverlap: number;
  maxChunkSize: number;
}

export interface IndexOptions {
  forceReindex?: boolean;
  extensions?: string[];
  ignorePatterns?: string[];
}

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  chunksCreated: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
  errors?: string[];
  /** Git enrichment status */
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
  enrichmentDurationMs?: number;
  /** Detailed enrichment metrics (file/chunk signal breakdown) */
  enrichmentMetrics?: EnrichmentMetrics;
  /** Schema and sparse vector migrations applied during this operation */
  migrations?: string[];
  /** Present only during auto-reindex via index_codebase */
  changeDetails?: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    filesNewlyIgnored: number;
    filesNewlyUnignored: number;
    chunksAdded: number;
    chunksDeleted: number;
  };
}

export interface ChangeStats {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  /** Files removed from index because they now match ignore patterns */
  filesNewlyIgnored: number;
  /** Files added to index because they no longer match ignore patterns */
  filesNewlyUnignored: number;
  chunksAdded: number;
  chunksDeleted: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
  /** Git enrichment status */
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
  enrichmentDurationMs?: number;
  /** Detailed enrichment metrics (file/chunk signal breakdown) */
  enrichmentMetrics?: EnrichmentMetrics;
  /** Schema and sparse vector migrations applied during this operation */
  migrations?: string[];
}

export type IndexingStatus = "not_indexed" | "indexing" | "indexed" | "stale_indexing" | "unavailable";

/** Metrics from streaming git enrichment (parallel with embedding) */
export interface EnrichmentMetrics {
  /** Time spent reading git log */
  prefetchDurationMs: number;
  /** How much git log overlapped with embedding (ms) */
  overlapMs: number;
  /** Overlap as fraction of git log time (0.0-1.0) */
  overlapRatio: number;
  /** Batches applied via callback while embedding was still running */
  streamingApplies: number;
  /** Batches applied from pending queue after git log resolved */
  flushApplies: number;
  /** Time spent on chunk-level churn analysis */
  chunkChurnDurationMs: number;
  /** Total enrichment wall time */
  totalDurationMs: number;
  /** Files that matched in the git log map */
  matchedFiles: number;
  /** Files with no entry in git log (not modified in GIT_LOG_MAX_AGE_MONTHS window) */
  missedFiles: number;
  /** First 10 unmatched paths for diagnosing issues */
  missedPathSamples: string[];
  /** Total files present in git log output (contextualizes matchedFiles) */
  gitLogFileCount: number;
  /** Estimated ms saved by streaming overlap vs sequential execution */
  estimatedSavedMs: number;
}

export interface IndexStatus {
  /** @deprecated Use `status` instead. True only when status is 'indexed'. */
  isIndexed: boolean;
  /** Current indexing status: 'not_indexed', 'indexing', or 'indexed' */
  status: IndexingStatus;
  collectionName?: string;
  filesCount?: number;
  chunksCount?: number;
  lastUpdated?: Date;
  languages?: string[];
  /** Embedding model used to index this collection */
  embeddingModel?: string;
  /** Qdrant URL (useful for embedded Qdrant with dynamic ports) */
  qdrantUrl?: string;
  /** Per-provider enrichment health (e.g. { git: { file: ..., chunk: ... } }) */
  enrichment?: EnrichmentHealthMap;
  /** BM25 sparse vector version (from schema metadata) */
  sparseVersion?: number;
  /** Infrastructure health status (Qdrant + embedding provider) */
  infraHealth?: {
    qdrant: { available: boolean; url: string };
    embedding: { available: boolean; provider: string; url?: string };
  };
}

export type ProgressCallback = (progress: ProgressUpdate) => void;

export interface ProgressUpdate {
  phase: "scanning" | "chunking" | "embedding" | "storing" | "enriching";
  current: number;
  total: number;
  percentage: number;
  message: string;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  metadata: {
    filePath: string;
    language: string;
    chunkIndex: number;
    chunkType?: "function" | "class" | "interface" | "block" | "test" | "test_setup";
    name?: string; // Function/class name if applicable
    parentName?: string; // Parent class/module name for methods extracted from large classes
    parentType?: string; // Parent AST node type (e.g., "class", "module")
    /** Symbol identifier: "ClassName.methodName" or just "functionName" */
    symbolId?: string;
    /** Non-contiguous line ranges (e.g., Ruby body groups with gaps where methods live) */
    lineRanges?: { start: number; end: number }[];
    /**
     * True for documentation chunks (markdown, etc.)
     * Used to filter search results: include/exclude documentation
     */
    isDocumentation?: boolean;

    /**
     * Imports extracted from the file (file-level, inherited by all chunks)
     * Used for imports structural signal in reranking
     */
    imports?: string[];

    /** Original method/block line count before chunk splitting. Used by decomposition signals. */
    methodLines?: number;
  };
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Files in `deleted` that still exist on disk (removed due to ignore pattern changes) */
  newlyIgnored: string[];
  /** Files in `added` that existed before the previous snapshot (added due to ignore pattern changes) */
  newlyUnignored: string[];
}

/** Maps a chunk to its point ID for Phase 2 git enrichment */
export interface ChunkLookupEntry {
  chunkId: string;
  startLine: number;
  endLine: number;
  /** Non-contiguous line ranges for precise overlap detection (e.g., Ruby body groups) */
  lineRanges?: { start: number; end: number }[];
}

// trigger
