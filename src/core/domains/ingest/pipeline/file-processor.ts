/**
 * FileProcessor - Shared file processing logic for indexing pipelines.
 *
 * Owns the BATCH shape: the bounded-concurrency fan-out over a file list and
 * the shared result accumulator. What happens to one file (read → skip policy
 * → chunk → submit → telemetry) belongs to `SourceFileIngestor`.
 * Eliminates duplication between IndexPipeline and ReindexPipeline.
 */

import { join } from "node:path";

import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import { isDebug } from "../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../types.js";
import type { ReindexCoordinator } from "../sync/deletion/reindex-coordinator.js";
import type { QuarantineStore } from "../sync/index.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkerPool } from "./chunker/infra/pool.js";
import { SourceFileIngestor } from "./file-ingestor.js";
import { parallelLimit } from "./infra/parallel.js";

// Historical import path for the post-chunk navigation pass — it now lives
// beside the chunker (see chunker/chunk-navigation.ts) so `SourceFileIngestor`
// can call it without importing this module back.
export { assignNavigationAndDocSymbolId } from "./chunker/chunk-navigation.js";

export interface FileProcessorOptions {
  enableGitMetadata: boolean;
  maxChunksPerFile?: number;
  maxTotalChunks?: number;
  concurrency?: number;
  /**
   * Optional per-file barrier. When set, files whose delete silently failed
   * (tracked by the coordinator) are skipped from upsert to prevent orphan
   * duplicates. Pass ONLY for the modified-files pass — added files have no
   * old chunks to collide with. See reindex-resilience plan Phase 3.2.
   */
  coordinator?: ReindexCoordinator;
  /**
   * Optional poison-pill quarantine. When set, files that fail to read or parse
   * are recorded here (instead of silently dropping out of the index) and
   * retried automatically on every subsequent indexing pass.
   */
  quarantineStore?: QuarantineStore;
  /**
   * Paths (relative to basePath) that were quarantined on a prior pass and are
   * being retried this pass. A file in this set that now processes successfully
   * is cleared from the quarantine. Files NOT in this set never trigger a clear,
   * so the common (never-failed) case pays no extra write.
   */
  quarantinedRetry?: Set<string>;
  /**
   * yl9tv cross-pass. When set (codegraph enabled), the chunker worker also
   * emits a codegraph `FileExtraction` from the SAME parse it chunks with, and
   * this hook forwards it (with a root-relative `relPath`) to the enrichment
   * coordinator → codegraph provider spill — eliminating the provider's
   * main-thread re-parse. Presence of this hook is what flips the worker's
   * `emitExtraction` on.
   */
  onFileExtraction?: (extraction: FileExtraction) => void;
}

export interface FileProcessResult {
  chunksCreated: number;
  filesProcessed: number;
  chunkMap: Map<string, ChunkLookupEntry[]>;
  errors: string[];
}

export interface FileProcessCallbacks {
  onFileProcessed?: (filePath: string, chunksCount: number) => void;
}

/**
 * Process a batch of files: read → secrets check → chunk → pipeline submit → enrichment track.
 *
 * @param absolutePaths - Absolute file paths to process
 * @param basePath - Base path of the codebase (for pipeline context)
 * @param chunkerPool - Pool for AST-aware chunking
 * @param chunkPipeline - Pipeline for embedding and storage
 * @param options - Processing options
 * @param callbacks - Optional callbacks for progress tracking
 */
export async function processFiles(
  absolutePaths: string[],
  basePath: string,
  chunkerPool: ChunkerPool,
  chunkPipeline: ChunkPipeline,
  options: FileProcessorOptions,
  callbacks?: FileProcessCallbacks,
): Promise<FileProcessResult> {
  const result: FileProcessResult = {
    chunksCreated: 0,
    filesProcessed: 0,
    chunkMap: new Map(),
    errors: [],
  };

  const concurrency = options.concurrency ?? 50;
  // One ingestor for the whole batch: it is stateless apart from the deps it
  // closes over, and every worker mutates the SAME `result` accumulator — the
  // single-threaded event loop is what makes the shared counters safe.
  const ingestor = new SourceFileIngestor({
    basePath,
    chunkerPool,
    chunkPipeline,
    options,
    callbacks,
    result,
  });

  await parallelLimit(absolutePaths, async (filePath) => ingestor.ingest(filePath), concurrency);

  return result;
}

/**
 * Process files given as relative paths, resolving them to absolute paths.
 * Merges resulting chunkMap entries into a provided shared map.
 *
 * Convenience wrapper for reindex workflows where file lists are relative to basePath.
 *
 * @param relativePaths - File paths relative to basePath
 * @param basePath - Base path of the codebase
 * @param chunkerPool - Pool for AST-aware chunking
 * @param chunkPipeline - Pipeline for embedding and storage
 * @param options - Processing options
 * @param chunkMap - Shared chunkMap to merge results into
 * @param label - Label for debug logging
 * @returns Number of chunks created
 */
export async function processRelativeFiles(
  relativePaths: string[],
  basePath: string,
  chunkerPool: ChunkerPool,
  chunkPipeline: ChunkPipeline,
  options: FileProcessorOptions,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  label: string,
): Promise<number> {
  if (relativePaths.length === 0) return 0;

  const absolutePaths = relativePaths.map((f) => join(basePath, f));

  if (isDebug()) {
    console.error(`[Reindex] ${label}: starting ${relativePaths.length} files`);
  }

  const result = await processFiles(absolutePaths, basePath, chunkerPool, chunkPipeline, options);

  // Merge chunkMap entries
  for (const [key, entries] of result.chunkMap) {
    const existing = chunkMap.get(key) || [];
    chunkMap.set(key, [...existing, ...entries]);
  }

  if (isDebug()) {
    console.error(`[Reindex] ${label}: completed ${relativePaths.length} files, ${result.chunksCreated} chunks queued`);
  }

  return result.chunksCreated;
}
