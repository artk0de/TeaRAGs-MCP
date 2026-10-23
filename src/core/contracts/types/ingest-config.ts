/**
 * Configuration contract for the ingest pipeline — consumed by bootstrap (to
 * build the runtime config), the ingest domain (BaseIndexingPipeline,
 * IndexPipeline, ReindexPipeline), and mcp formatters that surface
 * configuration values to the user.
 *
 * Lives in `contracts/` because both the assembly side (bootstrap) and the
 * implementation side (ingest) need the same shape without crossing a domain
 * boundary.
 */

/**
 * A directory recognised by what it holds rather than by its name: the
 * directory is pruned, subtree included, when EVERY one of `entries` exists in
 * it. An entry is a path relative to that directory (`resources/testharness.js`
 * names a nested file). The scanned root itself is never pruned — indexing an
 * upstream checkout on purpose stays possible.
 */
export interface IgnoredDirectoryMarker {
  /** Why such a directory stays out of the index — read by humans, never matched. */
  readonly reason: string;
  readonly entries: readonly string[];
}

/**
 * What one owner keeps out of the ingest index: `.gitignore`-syntax `patterns`
 * applied after the builtin ones, and `markedDirectories` recognised by their
 * contents. A language declares its own on `LanguageCapability.ingestIgnore`;
 * the composition root hands the aggregate to the scanner, which owns no
 * language.
 */
export interface IngestIgnoreContribution {
  readonly patterns?: readonly string[];
  readonly markedDirectories?: readonly IgnoredDirectoryMarker[];
}

/** Config for indexing pipelines (BaseIndexingPipeline, IndexPipeline, ReindexPipeline). */
export interface IngestCodeConfig {
  // Chunking
  chunkSize: number;
  chunkOverlap: number;

  // File discovery
  supportedExtensions: string[];
  ignorePatterns: string[];
  customIgnorePatterns?: string[];
  /**
   * Per-owner ignore contributions — the languages' aggregate, filled by the
   * composition root. Every `FileScanner` built from this config receives it,
   * so a walk and a single-path admission judge one rule.
   */
  ignoreContributions?: readonly IngestIgnoreContribution[];

  // Indexing
  maxChunksPerFile?: number;
  maxTotalChunks?: number;

  // Search (used at collection creation time)
  enableHybridSearch: boolean;
  quantizationScalar: boolean;
  turboQuant: boolean;

  // Git metadata (optional, adds author/commit info to chunks)
  enableGitMetadata?: boolean;

  /** True when user explicitly set INGEST_CHUNK_SIZE env var */
  userSetChunkSize?: boolean;

  /**
   * Total time (ms) enrichment completion waits for Qdrant to apply queued
   * payload writes (`QDRANT_TUNE_WRITE_BARRIER_BUDGET_MS`). Absent →
   * `DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS` (bd tea-rags-mcp-yf4je).
   */
  payloadWriteBarrierBudgetMs?: number;
}
