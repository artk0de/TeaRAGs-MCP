/**
 * Type definitions for code vectorization module
 */

export interface CodeConfig {
  // Chunking
  chunkSize: number;
  chunkOverlap: number;
  enableASTChunking: boolean;

  // File discovery
  supportedExtensions: string[];
  ignorePatterns: string[];
  customExtensions?: string[];
  customIgnorePatterns?: string[];

  // Indexing
  batchSize: number; // Embeddings per batch
  maxChunksPerFile?: number;
  maxTotalChunks?: number;

  // Search
  defaultSearchLimit: number;
  enableHybridSearch: boolean;

  // Git metadata (optional, adds author/commit info to chunks)
  enableGitMetadata?: boolean;
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
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background";
  enrichmentDurationMs?: number;
}

export interface ChangeStats {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  chunksAdded: number;
  chunksDeleted: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
  /** Git enrichment status */
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background";
  enrichmentDurationMs?: number;
}

export interface CodeSearchResult {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  fileExtension: string;
  /** Metadata including git information (if enableGitMetadata was true during indexing) */
  metadata?: {
    git?: {
      // Nested structure (new format from EnrichmentApplier)
      file?: {
        lastModifiedAt: number;
        firstCreatedAt: number;
        dominantAuthor: string;
        dominantAuthorEmail: string;
        authors: string[];
        dominantAuthorPct: number;
        commitCount: number;
        lastCommitHash: string;
        ageDays: number;
        linesAdded: number;
        linesDeleted: number;
        relativeChurn: number;
        recencyWeightedFreq: number;
        changeDensity: number;
        churnVolatility: number;
        bugFixRate: number;
        contributorCount: number;
        taskIds: string[];
      };
      chunk?: {
        commitCount?: number;
        churnRatio?: number;
        contributorCount?: number;
        bugFixRate?: number;
        lastModifiedAt?: number;
        ageDays?: number;
        relativeChurn?: number;
      };

      // Legacy flat fields (backward compat for old indexes)
      lastModifiedAt?: number;
      firstCreatedAt?: number;
      dominantAuthor?: string;
      dominantAuthorEmail?: string;
      authors?: string[];
      dominantAuthorPct?: number;
      commitCount?: number;
      lastCommitHash?: string;
      ageDays?: number;
      linesAdded?: number;
      linesDeleted?: number;
      relativeChurn?: number;
      recencyWeightedFreq?: number;
      changeDensity?: number;
      churnVolatility?: number;
      bugFixRate?: number;
      contributorCount?: number;
      taskIds?: string[];
    };
  };
}

export interface SearchOptions {
  limit?: number;
  useHybrid?: boolean;
  fileTypes?: string[];
  pathPattern?: string;
  scoreThreshold?: number;
  /** Search only in documentation files (markdown, etc.) */
  documentationOnly?: boolean;

  // Git metadata filters (requires enableGitMetadata during indexing)
  /** Filter by dominant author name */
  author?: string;
  /** Filter code modified after this date (ISO string or Date) */
  modifiedAfter?: string | Date;
  /** Filter code modified before this date (ISO string or Date) */
  modifiedBefore?: string | Date;
  /** Filter code older than N days */
  minAgeDays?: number;
  /** Filter code newer than N days */
  maxAgeDays?: number;
  /** Filter by minimum commit count (churn) */
  minCommitCount?: number;
  /** Filter by task ID (e.g., "TD-1234", "#567") */
  taskId?: string;
  /** Reranking mode: preset name or custom weights */
  rerank?: "relevance" | "recent" | "stable" | { custom: Record<string, number> };
}

export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

/** Status of background git enrichment */
export type EnrichmentStatusValue = "pending" | "in_progress" | "completed" | "partial" | "failed";

export interface EnrichmentInfo {
  status: EnrichmentStatusValue;
  totalFiles?: number;
  processedFiles?: number;
  percentage?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  failedFiles?: number;
  /** Files that matched in the git log map */
  matchedFiles?: number;
  /** Files with no entry in git log (not modified within GIT_LOG_MAX_AGE_MONTHS) */
  missedFiles?: number;
  /** Total files present in git log (contextualizes matchedFiles/missedFiles) */
  gitLogFileCount?: number;
}

/** Status of background chunk-level git enrichment */
export interface ChunkEnrichmentInfo {
  status: "in_progress" | "completed" | "failed";
  overlaysApplied?: number;
  durationMs?: number;
}

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
  /** Background git enrichment progress (file-level) */
  enrichment?: EnrichmentInfo;
  /** Background chunk-level git enrichment progress */
  chunkEnrichment?: ChunkEnrichmentInfo;
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
    chunkType?: "function" | "class" | "interface" | "block";
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
  };
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** Maps a chunk to its point ID for Phase 2 git enrichment */
export interface ChunkLookupEntry {
  chunkId: string;
  startLine: number;
  endLine: number;
  /** Non-contiguous line ranges for precise overlap detection (e.g., Ruby body groups) */
  lineRanges?: { start: number; end: number }[];
}
