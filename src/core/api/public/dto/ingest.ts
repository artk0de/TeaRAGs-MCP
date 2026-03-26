/**
 * Ingest domain DTOs — indexing request/response types.
 *
 * App-facing types only. Internal pipeline types stay in core/types.ts.
 */

import type {
  ChunkEnrichmentInfo,
  EnrichmentInfo,
  EnrichmentMetrics,
  IndexingStatus,
  ProgressUpdate,
} from "../../../types.js";

// ---------------------------------------------------------------------------
// Indexing options
// ---------------------------------------------------------------------------

export interface IndexOptions {
  forceReindex?: boolean;
  extensions?: string[];
  ignorePatterns?: string[];
}

// ---------------------------------------------------------------------------
// Indexing results
// ---------------------------------------------------------------------------

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
  /** Detailed enrichment metrics (file/chunk signal breakdown) */
  enrichmentMetrics?: EnrichmentMetrics;
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
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background";
  enrichmentDurationMs?: number;
  /** Detailed enrichment metrics (file/chunk signal breakdown) */
  enrichmentMetrics?: EnrichmentMetrics;
}

// ---------------------------------------------------------------------------
// Index status
// ---------------------------------------------------------------------------

export interface IndexStatus {
  /** @deprecated Use `status` instead. True only when status is 'indexed'. */
  isIndexed: boolean;
  /** Current indexing status */
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
  /** Background git enrichment progress (file-level) */
  enrichment?: EnrichmentInfo;
  /** Background chunk-level git enrichment progress */
  chunkEnrichment?: ChunkEnrichmentInfo;
  /** BM25 sparse vector version (from schema metadata) */
  sparseVersion?: number;
  /** Infrastructure health status (Qdrant + embedding provider) */
  infraHealth?: {
    qdrant: { available: boolean; url: string };
    embedding: { available: boolean; provider: string; url?: string };
  };
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressCallback = (progress: ProgressUpdate) => void;
