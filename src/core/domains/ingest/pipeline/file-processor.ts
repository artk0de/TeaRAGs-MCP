/**
 * FileProcessor - Shared file processing logic for indexing pipelines.
 *
 * Owns the BATCH shape: the bounded-concurrency fan-out over a file list and
 * the shared result accumulator. What happens to one file (read → skip policy
 * → chunk → submit → telemetry) belongs to `SourceFileIngestor`.
 * Eliminates duplication between IndexPipeline and ReindexPipeline.
 */

import { join } from "node:path";

import { isDebug } from "../../../primitives/diagnostics/index.js";
import type { ChunkLookupEntry } from "../../../types.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkerPoolPort } from "./chunker/infra/pool.js";
import { SourceFileIngestor } from "./file-ingestor.js";
import type { FileProcessCallbacks, FileProcessorOptions, FileProcessResult } from "./file-process-types.js";
import { parallelLimit } from "./infra/parallel.js";

// Historical import path for the post-chunk navigation pass — it now lives
// beside the chunker (see chunker/chunk-navigation.ts) so `SourceFileIngestor`
// can call it without importing this module back.
export { assignNavigationAndDocSymbolId } from "./chunker/chunk-navigation.js";

// The option/result/callback contract declares in file-process-types.ts (bd
// tea-rags-mcp-54xwd.14) — the ingestor constructs nothing of this module, but
// its functions take these types, so a declaration here would close a cycle.
export type { FileProcessCallbacks, FileProcessorOptions, FileProcessResult } from "./file-process-types.js";

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
  chunkerPool: ChunkerPoolPort,
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
  chunkerPool: ChunkerPoolPort,
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
