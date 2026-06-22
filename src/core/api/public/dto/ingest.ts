/**
 * Ingest domain DTOs — indexing request/response types.
 *
 * App-facing types only. Internal pipeline types stay in core/types.ts.
 */

import type { EnrichmentHealthMap } from "../../../domains/ingest/pipeline/enrichment/types.js";
import type {
  CodegraphResolveSummary,
  EnrichmentMetrics,
  EnrichmentProgressCallback,
  EnrichmentProgressEvent,
  IndexingStatus,
  ProgressUpdate,
} from "../../../types.js";
import type { CollectionIdentifier } from "./common.js";

// Re-export the enrichment progress contract on the public surface so cli/mcp
// consumers import it without crossing into core/types.ts directly.
export type { EnrichmentProgressCallback, EnrichmentProgressEvent };

// ---------------------------------------------------------------------------
// Indexing options
// ---------------------------------------------------------------------------

export interface IndexOptions {
  forceReindex?: boolean;
  extensions?: string[];
  ignorePatterns?: string[];
}

// ---------------------------------------------------------------------------
// Indexing inputs
// ---------------------------------------------------------------------------

/**
 * Input DTO for `indexCodebase`. Identifies the target collection via
 * {@link CollectionIdentifier} (collection > project > path) and carries
 * optional indexing knobs.
 */
export interface IndexCodebaseInput extends CollectionIdentifier, IndexOptions {}

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
    /** Previously-quarantined files re-attempted this pass (unchanged content). */
    filesRetried: number;
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
  /** Previously-quarantined files re-attempted this pass (unchanged content). */
  filesRetried: number;
  chunksAdded: number;
  chunksDeleted: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
  /** Git enrichment status */
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
  enrichmentDurationMs?: number;
  /** Detailed enrichment metrics (file/chunk signal breakdown) */
  enrichmentMetrics?: EnrichmentMetrics;
  /**
   * Files whose upsert was skipped because their delete silently failed.
   * Their old chunks remain in the index and will be retried on next reindex.
   * Present only when at least one path was blocked (see Phase 3.2).
   */
  filesSkippedDueToDeleteFailure?: number;
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
  /** Codegraph resolve-quality from the persisted cg_run_stats table (tea-rags-mcp-ykj7 / cnqrg / 7m5xz). */
  codegraphResolve?: CodegraphResolveSummary;
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
    embedding: {
      available: boolean;
      provider: string;
      url?: string;
      /** Live reachability of the CONFIGURED primary endpoint, independent of failover. */
      primaryAvailable?: boolean;
      fallbackUrl?: string;
      /** Live reachability of the fallback endpoint. Omitted when no fallback configured. */
      fallbackAvailable?: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressCallback = (progress: ProgressUpdate) => void;
