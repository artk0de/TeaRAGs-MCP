/**
 * Ingest domain DTOs — indexing request/response types.
 *
 * App-facing types only. Internal pipeline types stay in core/types.ts.
 */

import type { ChunkEnrichmentInfo, EnrichmentInfo, IndexingStatus, ProgressUpdate } from "../../../types.js";

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

// ---------------------------------------------------------------------------
// Index status
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressCallback = (progress: ProgressUpdate) => void;
