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
}

export interface ChangeStats {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  chunksAdded: number;
  chunksDeleted: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
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
      /** Unix timestamp of most recent change in chunk */
      lastModifiedAt: number;
      /** Unix timestamp of oldest change in chunk (first created) */
      firstCreatedAt: number;
      /** Author with most lines in this chunk */
      dominantAuthor: string;
      /** Email of dominant author */
      dominantAuthorEmail: string;
      /** All unique authors who touched this chunk */
      authors: string[];
      /** Number of unique commits (churn indicator) */
      commitCount: number;
      /** Commit hash of the most recent change */
      lastCommitHash: string;
      /** Days since last modification */
      ageDays: number;
      /** Task IDs from commits touching this chunk (e.g., ["TD-1234", "#567"]) */
      taskIds: string[];
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
}

export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

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
}

export type ProgressCallback = (progress: ProgressUpdate) => void;

export interface ProgressUpdate {
  phase: "scanning" | "chunking" | "embedding" | "storing";
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

    // Git metadata (populated when enableGitMetadata is true)
    // Uses canonical algorithm: one blame per file, aggregated signals only
    git?: {
      /** Unix timestamp of most recent change in chunk */
      lastModifiedAt: number;
      /** Unix timestamp of oldest change in chunk (first created) */
      firstCreatedAt: number;
      /** Author with most lines in this chunk */
      dominantAuthor: string;
      /** Email of dominant author */
      dominantAuthorEmail: string;
      /** All unique authors who touched this chunk */
      authors: string[];
      /** Number of unique commits (churn indicator) */
      commitCount: number;
      /** Commit hash of the most recent change */
      lastCommitHash: string;
      /** Days since last modification */
      ageDays: number;
      /** Task IDs from commits touching this chunk (e.g., ["TD-1234", "#567"]) */
      taskIds: string[];
    };
  };
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}
