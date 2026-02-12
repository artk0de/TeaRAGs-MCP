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

      // Chunk-level churn overlay (optional)
      chunkCommitCount?: number;
      chunkChurnRatio?: number;
      chunkContributorCount?: number;
      chunkBugFixRate?: number;
      chunkLastModifiedAt?: number;
      chunkAgeDays?: number;
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
  rerank?:
    | "relevance"
    | "recent"
    | "stable"
    | { custom: Record<string, number> };
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
    /**
     * True for documentation chunks (markdown, etc.)
     * Used to filter search results: include/exclude documentation
     */
    isDocumentation?: boolean;

    /**
     * Imports extracted from the file (file-level, inherited by all chunks)
     * Used for impactAnalysis reranking
     */
    imports?: string[];

    // Git metadata (populated when enableGitMetadata is true)
    // File-level metrics from git log via isomorphic-git (all chunks of a file share the same)
    git?: {
      /** Unix timestamp of most recent commit */
      lastModifiedAt: number;
      /** Unix timestamp of first commit */
      firstCreatedAt: number;
      /** Author with most commits to this file */
      dominantAuthor: string;
      /** Email of dominant author */
      dominantAuthorEmail: string;
      /** All unique authors who touched this file */
      authors: string[];
      /** Percentage of commits by dominant author */
      dominantAuthorPct: number;
      /** Total commits touching this file */
      commitCount: number;
      /** Commit hash of the most recent change */
      lastCommitHash: string;
      /** Days since last modification */
      ageDays: number;
      /** Total lines added across all commits */
      linesAdded: number;
      /** Total lines deleted across all commits */
      linesDeleted: number;
      /** (linesAdded + linesDeleted) / currentLines */
      relativeChurn: number;
      /** Recency-weighted commit frequency */
      recencyWeightedFreq: number;
      /** commits / months */
      changeDensity: number;
      /** stddev(days between commits) */
      churnVolatility: number;
      /** Percentage of commits with fix/bug/hotfix/patch keywords (0-100) */
      bugFixRate: number;
      /** Number of unique contributors */
      contributorCount: number;
      /** Task IDs from commit messages (e.g., ["TD-1234", "#567"]) */
      taskIds: string[];

      // Chunk-level churn overlay (Phase B, optional — only when chunk-level analysis is enabled)
      /** Commits that touched lines of this specific chunk */
      chunkCommitCount?: number;
      /** chunkCommitCount / file.commitCount (0-1) */
      chunkChurnRatio?: number;
      /** Unique authors who modified this specific chunk */
      chunkContributorCount?: number;
      /** Percentage of bug-fix commits for this chunk (0-100) */
      chunkBugFixRate?: number;
      /** Unix timestamp of last modification to this chunk */
      chunkLastModifiedAt?: number;
      /** Days since last modification to this chunk */
      chunkAgeDays?: number;
    };
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
}
