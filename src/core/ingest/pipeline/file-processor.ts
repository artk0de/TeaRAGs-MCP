/**
 * FileProcessor - Shared file processing logic for indexing pipelines.
 *
 * Reads files, checks for secrets, chunks them, and sends to ChunkPipeline.
 * Eliminates duplication between IndexPipeline and ReindexPipeline.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { ChunkLookupEntry, CodeChunk } from "../../types.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkerPool } from "./chunker/infra/pool.js";
import { generateChunkId } from "./chunker/utils/chunk-id.js";
import { extractImportsExports } from "./chunker/utils/import-extractor.js";
import { detectLanguage } from "./chunker/utils/language-detector.js";
import { containsSecrets } from "./chunker/utils/secrets-detector.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { parallelLimit } from "./infra/parallel.js";
import { isDebug } from "./infra/runtime.js";

export interface FileProcessorOptions {
  enableGitMetadata: boolean;
  maxChunksPerFile?: number;
  maxTotalChunks?: number;
  concurrency?: number;
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

  await parallelLimit(
    absolutePaths,
    async (filePath) => {
      try {
        const code = await fs.readFile(filePath, "utf-8");

        if (containsSecrets(code)) {
          result.errors.push(`Skipped ${filePath}: potential secrets detected`);
          return;
        }

        const language = detectLanguage(filePath);
        const { imports } = extractImportsExports(code, language);
        const parseStart = Date.now();
        const { chunks } = await chunkerPool.processFile(filePath, code, language);
        pipelineLog.addStageTime("parse", Date.now() - parseStart);

        // Apply chunk limits if configured
        const chunksToAdd = options.maxChunksPerFile ? chunks.slice(0, options.maxChunksPerFile) : chunks;

        for (const chunk of chunksToAdd) {
          // Check total chunk limit
          if (options.maxTotalChunks && result.chunksCreated >= options.maxTotalChunks) {
            return;
          }

          const baseChunk = {
            content: chunk.content,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            metadata: {
              filePath: chunk.metadata.filePath,
              language: chunk.metadata.language,
              chunkIndex: chunk.metadata.chunkIndex,
              name: chunk.metadata.name,
              chunkType: chunk.metadata.chunkType,
              parentName: chunk.metadata.parentName,
              parentType: chunk.metadata.parentType,
              symbolId: chunk.metadata.symbolId,
              isDocumentation: chunk.metadata.isDocumentation,
              ...(imports.length > 0 && { imports }),
            } as CodeChunk["metadata"],
          };

          // Wait for backpressure if needed
          if (chunkPipeline.isBackpressured()) {
            await chunkPipeline.waitForBackpressure(30000);
          }

          // Send chunk to pipeline immediately
          const chunkId = generateChunkId(chunk);
          chunkPipeline.addChunk(baseChunk as CodeChunk, chunkId, basePath);
          result.chunksCreated++;

          // Track for git enrichment
          if (options.enableGitMetadata) {
            const entries = result.chunkMap.get(filePath) || [];
            entries.push({
              chunkId,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              lineRanges: chunk.metadata.lineRanges,
            });
            result.chunkMap.set(filePath, entries);
          }
        }

        result.filesProcessed++;
        callbacks?.onFileProcessed?.(filePath, chunksToAdd.length);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(`Skipped ${filePath}: ${errorMessage}`);
      }
    },
    concurrency,
  );

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
