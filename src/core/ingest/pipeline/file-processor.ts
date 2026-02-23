/**
 * FileProcessor - Shared file processing logic for indexing pipelines.
 *
 * Reads files, checks for secrets, chunks them, and sends to ChunkPipeline.
 * Eliminates duplication between IndexPipeline and ReindexPipeline.
 */

import { promises as fs } from "node:fs";

import type { ChunkerPool } from "./chunker/utils/pool.js";
import type { ChunkLookupEntry, CodeChunk } from "../../types.js";
import { generateChunkId } from "./chunk-id.js";
import { containsSecrets } from "./secrets-detector.js";
import { detectLanguage } from "./language-detector.js";
import { extractImportsExports } from "./import-extractor.js";
import { pipelineLog } from "./debug-logger.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import { parallelLimit } from "../../utils/parallel.js";

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

  const concurrency = options.concurrency ?? parseInt(process.env.FILE_PROCESSING_CONCURRENCY || "50", 10);

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
