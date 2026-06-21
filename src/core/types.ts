// Copyright (c) 2025 Martin Halder <halderm@arkadia-labs.io>
// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Type definitions for code vectorization module.
 *
 * Types referenced from `contracts/` (ChunkLookupEntry, ProviderRunMetrics,
 * IngestCodeConfig, EnrichmentHealthMap) now live in contracts; re-exported
 * here for back-compat with consumers that still reference the old root path.
 * New code should import from `contracts/` directly (or via `api/public`).
 */

import type { EnrichmentHealthMap } from "./contracts/types/enrichment.js";
import type { ProviderRunMetrics } from "./contracts/types/provider.js";

// Back-compat re-exports of types relocated into contracts/.
export type { IngestCodeConfig } from "./contracts/types/ingest-config.js";
export type { ChunkLookupEntry } from "./contracts/types/chunker.js";
export type { ProviderRunMetrics } from "./contracts/types/provider.js";

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
  /**
   * Absolute path to the compiled `domains/language` barrel (`index.js`), used
   * by the chunker worker (a second composition root) to load native language
   * providers + the `LanguageFactory` / `DefaultSymbolIdComposer` via a
   * RUNTIME dynamic `import(path)`. Injected as a serializable string through
   * `workerData` so it survives the `postMessage` boundary (functions / native
   * handles do not). Passing a runtime string — not a static import — is what
   * keeps `domains/ingest` free of any `domains/language` import (the
   * leaf-domain eslint guard inspects only literal import specifiers, never a
   * variable path). Optional: the main-thread chunker (tests, single-thread)
   * receives a fully-built `LanguageFactoryDescriptor` via DI and ignores this.
   */
  languageModulePath?: string;
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
  /** Schema and sparse vector migrations applied during this operation */
  migrations?: string[];
  /**
   * Files whose upsert was skipped because their delete silently failed.
   * Their old chunks remain in the index and will be retried on next reindex.
   * Present only when at least one path was blocked (see Phase 3.2).
   */
  filesSkippedDueToDeleteFailure?: number;
}

export type IndexingStatus = "not_indexed" | "indexing" | "indexed" | "stale_indexing" | "unavailable";

/** Metrics from streaming enrichment (parallel with embedding) */
export interface EnrichmentMetrics {
  /** Time spent reading git log */
  prefetchDurationMs: number;
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
  /**
   * Provider-specific counters keyed by `provider.key`. Coordinator
   * collects via the optional `provider.getRunMetrics()` hook. Absent
   * when no provider exposes it.
   */
  byProvider?: Record<string, ProviderRunMetrics>;
}

/**
 * tea-rags-mcp-ykj7 — post-hoc codegraph resolve-quality, read from the
 * persisted `cg_run_stats` table at status time (NOT a per-payload signal, so
 * it lives here on IndexStatus rather than in `get_index_metrics`, which is the
 * signal-statistics DTO per the Stats-vs-Metrics rule). Absent when codegraph
 * was not indexed for the collection or the run-stats table is empty.
 */
export interface CodegraphResolveSummary {
  /** `callsResolved / max(1, callsAttempted − callsExternalSkipped)`; 0 when nothing attempted. */
  resolveSuccessRate: number;
  callsAttempted: number;
  callsResolved: number;
  /** Unresolved calls classified as external-library / runtime targets, excluded from the rate. */
  callsExternalSkipped: number;
  /**
   * tea-rags-mcp-cnqrg — per-code-language breakdown of the same rate, so a
   * polyglot index reveals WHICH language's resolver carries the gap. Test
   * call-sites are excluded from every tally (production-code capability only).
   * Restricted to officially-supported codegraph languages and filtered by the
   * same min-share rule as `get_index_metrics` (a language whose call-site
   * share is below the floor is omitted as noise). Absent when only one
   * language survives the filter (the aggregate already says it).
   */
  byLanguage?: CodegraphResolveLanguageRow[];
}

/**
 * tea-rags-mcp-cnqrg — one per-language slice of {@link CodegraphResolveSummary}.
 * `resolveSuccessRate` uses the same `resolved / max(1, attempted − external)`
 * formula as the aggregate, scoped to this language's call-sites.
 */
export interface CodegraphResolveLanguageRow {
  language: string;
  resolveSuccessRate: number;
  callsAttempted: number;
  callsResolved: number;
  callsExternalSkipped: number;
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
  /** Codegraph resolve-quality from the persisted cg_run_stats table (tea-rags-mcp-ykj7). */
  codegraphResolve?: CodegraphResolveSummary;
  /** BM25 sparse vector version (from schema metadata) */
  sparseVersion?: number;
  /**
   * Poison-pill quarantine summary. `count` is the number of files that broke
   * indexing (oversized chunk, parse/read failure, …) and were skipped instead
   * of aborting the pass. The full list with error codes is read by
   * `tea-rags doctor <project> --quarantine`, not exposed here.
   */
  quarantine?: { count: number };
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
    parentSymbolId?: string; // Parent class/module name for methods extracted from large classes
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

    /** Heading breadcrumb path for documentation chunks. Internal — stripped from API responses. */
    headingPath?: { depth: number; text: string }[];

    /** Navigation links to adjacent chunks in the same file. */
    navigation?: { prevSymbolId?: string; nextSymbolId?: string };

    /**
     * Transient. Set by the engine for chunks produced by a classifier `emit`
     * decision, and read by `mergeSmallChunks` to exempt them from adjacent
     * merging. NOT part of the persisted Qdrant payload (the payload builder
     * selects explicit fields).
     */
    claimed?: boolean;
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
