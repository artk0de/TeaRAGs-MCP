/**
 * Ingest domain DTOs — indexing request/response types.
 *
 * App-facing types only. Internal pipeline types stay in core/types.ts.
 */

import type { EnrichmentHealthMap } from "../../../domains/ingest/pipeline/enrichment/types.js";
import type { EnrichmentMetrics, IndexingStatus, ProgressUpdate } from "../../../types.js";

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
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
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
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
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
  /** Per-provider enrichment health (e.g. { git: { file: ..., chunk: ... } }) */
  enrichment?: EnrichmentHealthMap;
  /** BM25 sparse vector version (from schema metadata) */
  sparseVersion?: number;
  /** Infrastructure health status (Qdrant + embedding provider) */
  infraHealth?: {
    qdrant: {
      available: boolean;
      url: string;
      /** Qdrant collection health. `yellow` = background optimization running. */
      status?: "green" | "yellow" | "red";
      /** Optimizer state (`"ok"` or `"unknown"`). */
      optimizerStatus?: string;
    };
    embedding: { available: boolean; provider: string; url?: string };
  };
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressCallback = (progress: ProgressUpdate) => void;
