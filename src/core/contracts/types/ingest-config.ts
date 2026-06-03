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

/** Config for indexing pipelines (BaseIndexingPipeline, IndexPipeline, ReindexPipeline). */
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

  /** True when user explicitly set INGEST_CHUNK_SIZE env var */
  userSetChunkSize?: boolean;
}
